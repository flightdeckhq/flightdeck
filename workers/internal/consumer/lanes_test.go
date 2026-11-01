package consumer

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"sync"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// orderingProcessor records, per session, the order in which events were
// processed and on which goroutine, taking a random moment for each so
// that concurrent processing of one session would reorder them.
type orderingProcessor struct {
	mu      sync.Mutex
	seen    map[string][]int
	total   int
	want    int
	done    context.CancelFunc
	inFlt   map[string]int
	overlap bool
}

func (p *orderingProcessor) Process(_ context.Context, e EventPayload) error {
	p.mu.Lock()
	p.inFlt[e.SessionID]++
	if p.inFlt[e.SessionID] > 1 {
		p.overlap = true
	}
	p.mu.Unlock()

	time.Sleep(time.Duration(rand.Intn(300)) * time.Microsecond)

	var n int
	_, _ = fmt.Sscanf(e.ID, "%d", &n)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.inFlt[e.SessionID]--
	p.seen[e.SessionID] = append(p.seen[e.SessionID], n)
	p.total++
	if p.total == p.want {
		p.done()
	}
	return nil
}

func (p *orderingProcessor) StreamReady(context.Context, uint64) error { return nil }

func TestRun_ProcessesEachSessionsEventsInOrderOneAtATime(t *testing.T) {
	const sessions, perSession, batch = 12, 40, 7
	// Interleave the sessions' events the way a busy stream does.
	var msgs []*nats.Msg
	for i := range perSession {
		for s := range sessions {
			data, _ := json.Marshal(map[string]any{
				"session_id": fmt.Sprintf("session-%d", s),
				"event_type": "post_call",
				"id":         fmt.Sprintf("%d", i),
			})
			msgs = append(msgs, &nats.Msg{Data: data})
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	proc := &orderingProcessor{
		seen: map[string][]int{}, inFlt: map[string]int{}, want: len(msgs), done: cancel,
	}
	var mu sync.Mutex
	next := 0
	fetch := func() ([]*nats.Msg, error) {
		mu.Lock()
		defer mu.Unlock()
		if next >= len(msgs) {
			<-ctx.Done()
			return nil, context.Canceled
		}
		end := min(next+batch, len(msgs))
		out := msgs[next:end]
		next = end
		return out, nil
	}
	c := &Consumer{poolSize: 4, processor: proc}
	if err := c.run(ctx, fetch); err != nil {
		t.Fatalf("run: %v", err)
	}

	proc.mu.Lock()
	defer proc.mu.Unlock()
	if proc.total != len(msgs) {
		t.Fatalf("processed %d of %d events before the deadline", proc.total, len(msgs))
	}
	if proc.overlap {
		t.Fatalf("two events of one session were processed at the same time")
	}
	for s := range sessions {
		got := proc.seen[fmt.Sprintf("session-%d", s)]
		for i, n := range got {
			if n != i {
				t.Fatalf("session-%d processed out of order: %v", s, got)
			}
		}
	}
}

func TestLaneFor_IsStableAndSpreadsSessions(t *testing.T) {
	const lanes = 10
	used := map[int]bool{}
	for i := range 200 {
		sid := fmt.Sprintf("7a3afb1b-232a-4dd8-a2ea-%012d", i)
		lane := laneFor(sid, lanes)
		if lane != laneFor(sid, lanes) {
			t.Fatalf("lane for %s changed between calls", sid)
		}
		if lane < 0 || lane >= lanes {
			t.Fatalf("lane %d out of range", lane)
		}
		used[lane] = true
	}
	if len(used) != lanes {
		t.Fatalf("200 sessions used only %d of %d lanes", len(used), lanes)
	}
}

// blockingProcessor holds every event of one session until released or
// until its processing deadline, and records the others.
type blockingProcessor struct {
	mu      sync.Mutex
	stuck   string
	release chan struct{}
	seen    []string
	err     error
}

func (p *blockingProcessor) Process(ctx context.Context, e EventPayload) error {
	if e.SessionID == p.stuck {
		select {
		case <-p.release:
		case <-ctx.Done():
			p.mu.Lock()
			p.seen = append(p.seen, e.SessionID+":timeout")
			p.mu.Unlock()
			return ctx.Err()
		}
	}
	p.mu.Lock()
	p.seen = append(p.seen, e.SessionID+":"+e.ID)
	p.mu.Unlock()
	return p.err
}

func (p *blockingProcessor) StreamReady(context.Context, uint64) error { return nil }

func (p *blockingProcessor) has(entry string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, s := range p.seen {
		if s == entry {
			return true
		}
	}
	return false
}

func eventMsg(sessionID, id string) *nats.Msg {
	data, _ := json.Marshal(map[string]any{"session_id": sessionID, "event_type": "post_call", "id": id})
	return &nats.Msg{Data: data}
}

// oneShotFetch hands out msgs once, then waits for ctx.
func oneShotFetch(ctx context.Context, msgs []*nats.Msg) func() ([]*nats.Msg, error) {
	var once sync.Once
	return func() ([]*nats.Msg, error) {
		var out []*nats.Msg
		once.Do(func() { out = msgs })
		if out != nil {
			return out, nil
		}
		<-ctx.Done()
		return nil, context.Canceled
	}
}

// poll waits for cond, failing the test after a generous bound.
func poll(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestRun_ASessionStuckOnItsLaneDoesNotHoldTheOtherLanes(t *testing.T) {
	const lanes = 4
	stuck := "stuck-session"
	// One session per other lane, each with several events queued
	// behind the stuck session's in the fetch.
	var others []string
	for i := 0; len(others) < lanes-1; i++ {
		sid := fmt.Sprintf("other-%d", i)
		if laneFor(sid, lanes) == laneFor(stuck, lanes) {
			continue
		}
		dup := false
		for _, o := range others {
			if laneFor(o, lanes) == laneFor(sid, lanes) {
				dup = true
			}
		}
		if !dup {
			others = append(others, sid)
		}
	}
	msgs := []*nats.Msg{eventMsg(stuck, "0")}
	for i := range 20 {
		for _, sid := range others {
			msgs = append(msgs, eventMsg(sid, fmt.Sprintf("%d", i)))
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	proc := &blockingProcessor{stuck: stuck, release: make(chan struct{})}
	c := &Consumer{poolSize: lanes, processor: proc, processTimeout: time.Minute}
	done := make(chan struct{})
	go func() {
		_ = c.run(ctx, oneShotFetch(ctx, msgs))
		close(done)
	}()
	for _, sid := range others {
		poll(t, func() bool { return proc.has(sid + ":19") }, sid+"'s last event while another lane is stuck")
	}
	if proc.has(stuck + ":0") {
		t.Fatalf("the stuck session must still be held")
	}
	close(proc.release)
	poll(t, func() bool { return proc.has(stuck + ":0") }, "the stuck session once released")
	cancel()
	<-done
}

func TestRun_TheProcessingDeadlineFreesAStuckLane(t *testing.T) {
	stuck := "stuck-session"
	msgs := []*nats.Msg{eventMsg(stuck, "0"), eventMsg(stuck, "1")}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	proc := &blockingProcessor{stuck: stuck, release: make(chan struct{})}
	c := &Consumer{poolSize: 2, processor: proc, processTimeout: 20 * time.Millisecond}
	done := make(chan struct{})
	go func() {
		_ = c.run(ctx, oneShotFetch(ctx, msgs))
		close(done)
	}()
	// Both of the session's events reach their deadline in turn: the
	// first does not hold the second for ever.
	poll(t, func() bool {
		proc.mu.Lock()
		defer proc.mu.Unlock()
		n := 0
		for _, s := range proc.seen {
			if s == stuck+":timeout" {
				n++
			}
		}
		return n == 2
	}, "both events to time out in order")
	cancel()
	<-done
}

func TestLane_DueReportsLongWaitingMessagesOncePerInterval(t *testing.T) {
	l := newLane()
	t0 := time.Unix(1_000, 0)
	first := &nats.Msg{Subject: "first"}
	second := &nats.Msg{Subject: "second"}
	l.push(&laneEntry{msg: first, since: t0})
	if e, ok := l.next(); !ok || e.msg != first {
		t.Fatalf("expected the first message to be current")
	}
	l.push(&laneEntry{msg: second, since: t0.Add(5 * time.Second)})

	if got := l.due(t0.Add(9*time.Second), 10*time.Second); len(got) != 0 {
		t.Fatalf("nothing has waited an interval yet, got %d", len(got))
	}
	got := l.due(t0.Add(10*time.Second), 10*time.Second)
	if len(got) != 1 || got[0] != first {
		t.Fatalf("expected the current message to be due, got %v", got)
	}
	got = l.due(t0.Add(15*time.Second), 10*time.Second)
	if len(got) != 1 || got[0] != second {
		t.Fatalf("expected the queued message to be due and the current one not again, got %v", got)
	}
	l.finish()
	if got := l.due(t0.Add(30*time.Second), 10*time.Second); len(got) != 1 || got[0] != second {
		t.Fatalf("a finished message is no longer reported, got %v", got)
	}
}

func TestRun_KeepsWaitingMessagesAliveWhileTheirLaneIsBusy(t *testing.T) {
	stuck := "stuck-session"
	held := eventMsg(stuck, "0")
	waiting := eventMsg(stuck, "1")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	proc := &blockingProcessor{stuck: stuck, release: make(chan struct{})}
	var mu sync.Mutex
	touched := map[*nats.Msg]int{}
	c := &Consumer{
		poolSize: 1, processor: proc, processTimeout: time.Minute,
		keepaliveInterval: 5 * time.Millisecond,
		inProgress: func(m *nats.Msg) error {
			mu.Lock()
			touched[m]++
			mu.Unlock()
			return nil
		},
	}
	done := make(chan struct{})
	go func() {
		_ = c.run(ctx, oneShotFetch(ctx, []*nats.Msg{held, waiting}))
		close(done)
	}()
	poll(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return touched[held] >= 2 && touched[waiting] >= 2
	}, "the held and the waiting message to be reported in progress")
	close(proc.release)
	cancel()
	<-done
}
