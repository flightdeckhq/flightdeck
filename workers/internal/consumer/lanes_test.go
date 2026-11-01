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
