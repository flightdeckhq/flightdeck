package consumer

import (
	"context"
	"hash/fnv"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

// ackWait is how long the server waits for a delivered message's
// acknowledgement before it redelivers it. It is the JetStream default,
// set explicitly because the keepalive below is timed from it.
const ackWait = 30 * time.Second

// maxAckPending caps the messages delivered but not yet acknowledged,
// the JetStream default, set explicitly because it is what bounds the
// lanes' queues: the server stops delivering at the cap, so the fetch
// loop can hand messages on without ever waiting for a lane.
const maxAckPending = 1000

// keepaliveInterval is how often a message still waiting in a lane, or
// being processed, is reported in progress, which restarts its ack wait
// without spending a delivery. A third of the ack wait leaves two
// chances before the server would redeliver it.
const keepaliveInterval = ackWait / 3

// processTimeout bounds the processing of one message. A message stuck
// on the database (a held row lock) fails at the deadline and is
// redelivered later, so its lane moves on to the next message instead
// of stalling. Ten seconds is orders of magnitude above a normal event's
// processing time.
const processTimeout = 10 * time.Second

// laneEntry is a fetched message waiting in, or being processed by, a
// lane; since is when it was queued or last reported in progress.
type laneEntry struct {
	msg   *nats.Msg
	event EventPayload
	since time.Time
}

// lane is one session hash bucket's queue: the fetch loop appends, the
// lane's goroutine takes messages one at a time in order.
type lane struct {
	mu      sync.Mutex
	cond    *sync.Cond
	queue   []*laneEntry
	current *laneEntry
	closed  bool
}

func newLane() *lane {
	l := &lane{}
	l.cond = sync.NewCond(&l.mu)
	return l
}

// push queues a message. It never blocks: the server's ack-pending cap
// bounds how many messages can be queued across the lanes.
func (l *lane) push(e *laneEntry) {
	l.mu.Lock()
	l.queue = append(l.queue, e)
	l.mu.Unlock()
	l.cond.Signal()
}

// next waits for the lane's next message and marks it current; false
// once the lane is closed and empty.
func (l *lane) next() (*laneEntry, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for len(l.queue) == 0 && !l.closed {
		l.cond.Wait()
	}
	if len(l.queue) == 0 {
		return nil, false
	}
	e := l.queue[0]
	l.queue[0] = nil
	l.queue = l.queue[1:]
	l.current = e
	return e, true
}

// finish clears the current message once it has been answered.
func (l *lane) finish() {
	l.mu.Lock()
	l.current = nil
	l.mu.Unlock()
}

// close stops the lane: next returns the remaining messages, then false.
func (l *lane) close() {
	l.mu.Lock()
	l.closed = true
	l.mu.Unlock()
	l.cond.Broadcast()
}

// due returns the lane's messages, current and queued, that have gone
// unreported for at least age, and restarts their clock.
func (l *lane) due(now time.Time, age time.Duration) []*nats.Msg {
	l.mu.Lock()
	defer l.mu.Unlock()
	var out []*nats.Msg
	mark := func(e *laneEntry) {
		if e != nil && now.Sub(e.since) >= age {
			e.since = now
			out = append(out, e.msg)
		}
	}
	mark(l.current)
	for _, e := range l.queue {
		mark(e)
	}
	return out
}

// laneFor is the lane a session's messages go to: the same lane for
// every message of the session, so they are processed in stream order.
func laneFor(sessionID string, lanes int) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(sessionID))
	return int(h.Sum32() % uint32(lanes))
}

// keepalive reports every lane's long-waiting messages in progress until
// ctx is cancelled.
func (c *Consumer) keepalive(ctx context.Context, lanes []*lane) {
	ticker := time.NewTicker(c.keepaliveEvery())
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			for _, l := range lanes {
				for _, msg := range l.due(now, c.keepaliveEvery()) {
					_ = c.touch(msg)
				}
			}
		}
	}
}

func (c *Consumer) keepaliveEvery() time.Duration {
	if c.keepaliveInterval > 0 {
		return c.keepaliveInterval
	}
	return keepaliveInterval
}

func (c *Consumer) touch(msg *nats.Msg) error {
	if c.inProgress != nil {
		return c.inProgress(msg)
	}
	return msg.InProgress()
}

func (c *Consumer) processDeadline() time.Duration {
	if c.processTimeout > 0 {
		return c.processTimeout
	}
	return processTimeout
}
