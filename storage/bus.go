package storage

import (
	"context"
	"sync"
)

// The channels the services exchange notifications on. The names are
// the Postgres NOTIFY channels, so a notification from a database
// trigger and one from a store arrive on the same subscription.
const (
	// ChannelFleet carries a session or agent change for the
	// dashboard's WebSocket push: a JSON object with session_id,
	// event_type and event_id.
	ChannelFleet = "flightdeck_fleet"
	// ChannelAccessTokenRevoked carries the id of a deleted
	// access_tokens row; cached validations of that token must go.
	ChannelAccessTokenRevoked = "flightdeck_access_token_revoked"
)

// Bus carries the notifications the services exchange: a session or
// agent changed (ChannelFleet), an access token was revoked
// (ChannelAccessTokenRevoked). It replaces direct Postgres LISTEN/NOTIFY
// so the same store code runs on SQLite, where every service is one
// process and the bus is in-memory.
//
// Payloads are short strings; the channels and payload formats are the
// ones the services already use on Postgres.
type Bus interface {
	// Publish delivers payload to every current subscriber of channel.
	// A published payload reaches the subscribers that exist at that
	// moment; a subscription that starts later does not see it.
	Publish(ctx context.Context, channel, payload string) error

	// Subscribe returns a channel that receives every payload published
	// on channel until ctx is done or the subscription is lost (a
	// Postgres LISTEN connection failed); either way the channel is
	// then closed. A subscriber that must not miss a notification
	// treats a close before ctx is done as a gap: it re-reads the
	// state it caches and subscribes again.
	Subscribe(ctx context.Context, channel string) (<-chan string, error)
}

// NewBus returns the bus matching the database: in-process on SQLite,
// Postgres LISTEN/NOTIFY on Postgres, where other processes on the
// same database must see the notifications too.
func NewBus(db *DB) Bus {
	if db.Backend == Postgres {
		return NewPostgresBus(db.DB, db.url)
	}
	return NewInProcessBus()
}

// busBuffer is how many undelivered payloads a subscription holds
// before a publisher waits for the subscriber. A revocation or a fleet
// change is a few hundred bytes and the subscribers do a map delete or
// one row read per payload, so 256 covers a burst (the hub's
// per-client queue is sized the same) without letting a stuck
// subscriber consume unbounded memory.
const busBuffer = 256

// InProcessBus delivers notifications between goroutines of one
// process. It is the bus of SQLite mode.
type InProcessBus struct {
	mu   sync.Mutex
	subs map[string]map[*inProcessSub]struct{}
}

type inProcessSub struct {
	ch   chan string
	done <-chan struct{}
	// mu orders sends before the close: publishers hold it shared
	// while they send, so any number of them deliver (or wait on their
	// own context) at once, and the unsubscribe takes it exclusively
	// to close the channel once no send is in flight. A publisher
	// waiting on a full buffer also selects on done, so the close is
	// never held up for longer than that publisher takes to notice the
	// subscriber is gone.
	mu     sync.RWMutex
	closed bool
}

// NewInProcessBus returns an empty in-process bus.
func NewInProcessBus() *InProcessBus {
	return &InProcessBus{subs: make(map[string]map[*inProcessSub]struct{})}
}

// Publish hands payload to every subscriber of channel. It waits for a
// subscriber whose buffer is full, so a notification is never dropped
// while the subscriber is alive; the wait ends when ctx or the
// subscriber's context ends. Publishers never wait for each other: a
// publisher blocked on one slow subscriber holds no lock that another
// publisher, or the same subscriber's unsubscribe, needs.
func (b *InProcessBus) Publish(ctx context.Context, channel, payload string) error {
	b.mu.Lock()
	targets := make([]*inProcessSub, 0, len(b.subs[channel]))
	for s := range b.subs[channel] {
		targets = append(targets, s)
	}
	b.mu.Unlock()

	for _, s := range targets {
		if err := s.send(ctx, payload); err != nil {
			return err
		}
	}
	return nil
}

// send delivers payload to the subscriber unless it has unsubscribed,
// waiting on a full buffer until ctx or the subscriber's context ends.
func (s *inProcessSub) send(ctx context.Context, payload string) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.closed {
		return nil
	}
	select {
	case s.ch <- payload:
		return nil
	case <-s.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Subscribe registers a subscriber of channel; the returned channel is
// closed when ctx is done.
func (b *InProcessBus) Subscribe(ctx context.Context, channel string) (<-chan string, error) {
	s := &inProcessSub{ch: make(chan string, busBuffer), done: ctx.Done()}
	b.mu.Lock()
	if b.subs[channel] == nil {
		b.subs[channel] = make(map[*inProcessSub]struct{})
	}
	b.subs[channel][s] = struct{}{}
	b.mu.Unlock()

	go func() {
		<-ctx.Done()
		b.mu.Lock()
		delete(b.subs[channel], s)
		if len(b.subs[channel]) == 0 {
			delete(b.subs, channel)
		}
		b.mu.Unlock()
		s.mu.Lock()
		s.closed = true
		close(s.ch)
		s.mu.Unlock()
	}()
	return s.ch, nil
}
