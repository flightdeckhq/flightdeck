package storage

import (
	"context"
	"sync"
)

// Bus carries the notifications the services exchange: a session or
// agent changed (the dashboard's WebSocket push), an access token was
// revoked (cached validations must go). It replaces direct Postgres
// LISTEN/NOTIFY so the same store code runs on SQLite, where every
// service is one process and the bus is in-memory.
//
// Payloads are short strings; the channels and payload formats are the
// ones the services already use on Postgres (flightdeck_fleet carries a
// JSON object, flightdeck_access_token_revoked a token id).
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
	// mu serialises sends with the close, so a publisher never writes
	// to a channel the unsubscribe just closed.
	mu     sync.Mutex
	closed bool
}

// NewInProcessBus returns an empty in-process bus.
func NewInProcessBus() *InProcessBus {
	return &InProcessBus{subs: make(map[string]map[*inProcessSub]struct{})}
}

// Publish hands payload to every subscriber of channel. It waits for a
// subscriber whose buffer is full, so a notification is never dropped
// while the subscriber is alive; the wait ends when ctx or the
// subscriber's context ends.
func (b *InProcessBus) Publish(ctx context.Context, channel, payload string) error {
	b.mu.Lock()
	targets := make([]*inProcessSub, 0, len(b.subs[channel]))
	for s := range b.subs[channel] {
		targets = append(targets, s)
	}
	b.mu.Unlock()

	for _, s := range targets {
		s.mu.Lock()
		if !s.closed {
			select {
			case s.ch <- payload:
			case <-s.done:
			case <-ctx.Done():
				s.mu.Unlock()
				return ctx.Err()
			}
		}
		s.mu.Unlock()
	}
	return nil
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
