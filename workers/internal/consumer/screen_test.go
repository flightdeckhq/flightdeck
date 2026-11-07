package consumer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/logcap"
	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
	"github.com/nats-io/nats.go"
)

// hugeLen is the size of the oversized values below: the NATS payload
// limit, the largest string a direct publisher can put in a field.
const hugeLen = 1 << 20

// maxDropLineLen bounds the one log line a malformed session_id
// produces: the capped id, the capped event type, the message and a
// handful of short keys fit well within it.
const maxDropLineLen = 512

// syncBuffer is a bytes.Buffer safe for the dispatch and lane goroutines
// to log into at once.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) lines(substr string) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []string
	for _, l := range strings.Split(b.buf.String(), "\n") {
		if strings.Contains(l, substr) {
			out = append(out, l)
		}
	}
	return out
}

// captureLogs routes the default logger into a buffer for the test.
func captureLogs(t *testing.T) *syncBuffer {
	t.Helper()
	buf := &syncBuffer{}
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(buf, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return buf
}

func TestValidSessionID(t *testing.T) {
	valid := []string{
		"7a3afb1b-232a-4dd8-a2ea-000000000001",
		"7A3AFB1B-232A-4DD8-A2EA-0000000000FF", // ingestion accepts either case
		"00000000-0000-0000-0000-000000000000",
		"ffffffff-ffff-5fff-bfff-ffffffffffff", // any version and variant
	}
	for _, s := range valid {
		if !validSessionID(s) {
			t.Errorf("validSessionID(%q) = false, want true", s)
		}
	}
	invalid := map[string]string{
		"empty":               "",
		"not a uuid":          "not-a-uuid",
		"one short":           "7a3afb1b-232a-4dd8-a2ea-00000000000",
		"one long":            "7a3afb1b-232a-4dd8-a2ea-0000000000011",
		"no hyphens":          "7a3afb1b232a4dd8a2ea000000000001",
		"braces":              "{7a3afb1b-232a-4dd8-a2ea-000000000001}",
		"hyphen moved":        "7a3afb1b2-32a-4dd8-a2ea-000000000001",
		"hyphen as digit":     "7a3afb1b-232a-4dd8-a2ea-00000000000-",
		"non-hex digit":       "7a3afb1b-232a-4dd8-a2ea-00000000000g",
		"trailing newline":    "7a3afb1b-232a-4dd8-a2ea-00000000000\n",
		"leading space":       " 7a3afb1b-232a-4dd8-a2ea-00000000000",
		"multibyte, 36 bytes": "7a3afb1b-232a-4dd8-a2ea-0000000000é",
		"sql":                 "'; DROP TABLE sessions; --0000000000",
		"huge":                strings.Repeat("a", hugeLen),
	}
	for name, s := range invalid {
		if validSessionID(s) {
			t.Errorf("%s: validSessionID(%q) = true, want false", name, logcap.ID(s))
		}
	}
}

// recordingProcessor records the session and id of every event it
// processes and cancels the run once it has seen as many as the test
// expects.
type recordingProcessor struct {
	mu   sync.Mutex
	seen []string
	want int
	done context.CancelFunc
}

func (p *recordingProcessor) Process(_ context.Context, e EventPayload) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.seen = append(p.seen, e.SessionID+":"+e.ID)
	if len(p.seen) == p.want {
		p.done()
	}
	return nil
}

func (p *recordingProcessor) StreamReady(context.Context, uint64) error { return nil }

func rawMsg(t *testing.T, fields map[string]any) *nats.Msg {
	t.Helper()
	data, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return &nats.Msg{Data: data}
}

// A malformed session_id is terminated once, on its first delivery, and
// counted; it never reaches the processor, and the events fetched with
// and after it, of its own lane or another, are processed as usual.
func TestRun_TerminatesAMalformedSessionIDOnceAndKeepsGoing(t *testing.T) {
	captureLogs(t)
	good := testSessionID(1)
	other := testSessionID(2)
	bad := []*nats.Msg{
		rawMsg(t, map[string]any{"session_id": "not-a-uuid", "event_type": "post_call", "id": "b1"}),
		rawMsg(t, map[string]any{"event_type": "post_call", "id": "b2"}), // no session_id at all
		rawMsg(t, map[string]any{"session_id": strings.Repeat("9", hugeLen), "event_type": "post_call", "id": "b3"}),
		rawMsg(t, map[string]any{"session_id": "{" + good + "}", "event_type": "post_call", "id": "b4"}),
	}
	msgs := []*nats.Msg{
		eventMsg(good, "0"), bad[0], eventMsg(other, "0"), bad[1],
		eventMsg(good, "1"), bad[2], bad[3], eventMsg(other, "1"), eventMsg(good, "2"),
	}

	want := map[string]bool{good + ":0": true, good + ":1": true, good + ":2": true, other + ":0": true, other + ":1": true}

	before := metrics.Snapshot()[metrics.ReasonInvalidSessionID]
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	proc := &recordingProcessor{want: len(want), done: cancel}
	var mu sync.Mutex
	terminated := map[*nats.Msg]int{}
	c := &Consumer{poolSize: 4, processor: proc, term: func(m *nats.Msg) error {
		mu.Lock()
		defer mu.Unlock()
		terminated[m]++
		return nil
	}}
	if err := c.run(ctx, oneShotFetch(ctx, msgs)); err != nil {
		t.Fatalf("run: %v", err)
	}
	if !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatalf("the valid events after the malformed ones were not all processed: %v", proc.seen)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(terminated) != len(bad) {
		t.Fatalf("terminated %d messages, want the %d malformed ones", len(terminated), len(bad))
	}
	for i, m := range bad {
		if terminated[m] != 1 {
			t.Errorf("malformed message %d terminated %d times, want once", i, terminated[m])
		}
	}
	proc.mu.Lock()
	defer proc.mu.Unlock()
	if len(proc.seen) != len(want) {
		t.Fatalf("processed %v, want exactly %d valid events", proc.seen, len(want))
	}
	for _, s := range proc.seen {
		if !want[s] {
			t.Errorf("processed %q, which is not a valid event", logcap.ID(s))
		}
	}
	if got := metrics.Snapshot()[metrics.ReasonInvalidSessionID] - before; got != uint64(len(bad)) {
		t.Errorf("invalid_session_id counted %d, want %d", got, len(bad))
	}
}

// The drop is logged once, on one bounded line that names the reason,
// the event type and the id's length, carries at most the id's first 64
// bytes, and never carries the event's content.
func TestDropInvalidSessionID_LogsOneBoundedLineWithoutContent(t *testing.T) {
	logs := captureLogs(t)
	const marker = "MARKERMARKER"
	const secret = "SECRET-PROMPT-TEXT"
	sid := marker + strings.Repeat("x", hugeLen-len(marker))
	msg := rawMsg(t, map[string]any{
		"session_id":  sid,
		"event_type":  strings.Repeat("e", hugeLen),
		"has_content": true,
		"content":     map[string]any{"messages": []any{map[string]any{"role": "user", "content": secret}}},
	})
	var event EventPayload
	if err := json.Unmarshal(msg.Data, &event); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	terms := 0
	c := &Consumer{term: func(*nats.Msg) error { terms++; return nil }}
	c.dropInvalidSessionID(msg, event)

	if terms != 1 {
		t.Fatalf("terminated %d times, want once", terms)
	}
	lines := logs.lines("dropped event with malformed session_id")
	if len(lines) != 1 {
		t.Fatalf("logged %d drop lines, want 1: %q", len(lines), lines)
	}
	line := lines[0]
	if len(line) > maxDropLineLen {
		t.Fatalf("the drop line is %d bytes, want at most %d", len(line), maxDropLineLen)
	}
	for _, want := range []string{
		"level=WARN",
		"reason=invalid_session_id",
		"session_id_len=1048576",
		"session_id=\"" + marker,
		"…(1048576 bytes)",
	} {
		if !strings.Contains(line, want) {
			t.Errorf("drop line lacks %q: %s", want, line)
		}
	}
	if strings.Contains(line, secret) || strings.Contains(line, "messages") {
		t.Errorf("drop line carries the event's content: %s", line)
	}
}

// panickingProcessor fails every event the way a hostile payload could
// make it: an error quoting a huge input, or a panic with a huge value.
type panickingProcessor struct{ huge string }

func (p panickingProcessor) Process(_ context.Context, e EventPayload) error {
	if e.ID == "panic" {
		panic(p.huge)
	}
	return errors.New(`invalid input syntax for type uuid: "` + p.huge + `"`)
}

func (panickingProcessor) StreamReady(context.Context, uint64) error { return nil }

// A processing failure's error text, a recovered panic's value and the
// event type are capped on the consumer's log lines.
func TestHandle_CapsPayloadStringsOnItsLogLines(t *testing.T) {
	logs := captureLogs(t)
	huge := strings.Repeat("z", hugeLen)
	c := &Consumer{processor: panickingProcessor{huge: huge}}
	hugeType := strings.Repeat("t", hugeLen)
	sid := testSessionID(7)
	// A message with no JetStream metadata counts as its final delivery,
	// so each is terminated after one attempt.
	c.handle(context.Background(), &nats.Msg{}, EventPayload{SessionID: sid, EventType: hugeType, ID: "error"}, 0)
	c.handle(context.Background(), &nats.Msg{}, EventPayload{SessionID: sid, EventType: hugeType, ID: "panic"}, 0)

	// The longest line holds a 1 KiB error, a 64-byte event type and a
	// few short keys.
	const maxLineLen = logcap.MaxErr + 512
	for _, what := range []string{"process error", "recovered panic processing message"} {
		lines := logs.lines(what)
		if len(lines) == 0 {
			t.Fatalf("no %q line logged", what)
		}
		for _, line := range lines {
			if len(line) > maxLineLen {
				t.Errorf("%q line is %d bytes, want at most %d", what, len(line), maxLineLen)
			}
			if !strings.Contains(line, "session_id="+sid) {
				t.Errorf("%q line lacks the session id: %.200s", what, line)
			}
			if !strings.Contains(line, `event_type="`+strings.Repeat("t", logcap.MaxEventType)+"…(1048576 bytes)") {
				t.Errorf("%q line lacks the capped event type: %.200s", what, line)
			}
		}
	}
}
