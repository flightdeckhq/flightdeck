package otlpstage

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// The bounds are the values ARCHITECTURE.md (OTLP ingest > GenAI
// dialect) states; a change to one is a contract change.
func TestBoundsMatchTheContract(t *testing.T) {
	for name, got := range map[string][2]time.Duration{
		"StageTimeout":       {StageTimeout, 2 * time.Second},
		"RootGrace":          {RootGrace, 3 * time.Second},
		"AdkLogWait":         {AdkLogWait, 30 * time.Second},
		"QuietTimeout":       {QuietTimeout, 30 * time.Minute},
		"MaxTraceHold":       {MaxTraceHold, 24 * time.Hour},
		"LeaseTTL":           {LeaseTTL, 2 * time.Minute},
		"CompleteRetention":  {CompleteRetention, time.Hour},
		"DegradedRetention":  {DegradedRetention, 24 * time.Hour},
		"ContentBackstopAge": {ContentBackstopAge, 24*time.Hour + 30*time.Second},
	} {
		if got[0] != got[1] {
			t.Errorf("%s = %v, want %v", name, got[0], got[1])
		}
	}
	if MaxSpansPerTrace != 10000 {
		t.Errorf("MaxSpansPerTrace = %d, want 10000", MaxSpansPerTrace)
	}
}

func TestResolveAt(t *testing.T) {
	first := time.Date(2001, 1, 1, 0, 0, 0, 0, time.UTC)
	cases := []struct {
		name     string
		rootSeen bool
		now      time.Time
		want     time.Time
	}{
		{"root seen waits the root grace", true, first.Add(time.Minute), first.Add(time.Minute + RootGrace)},
		{"no root waits the quiet timeout", false, first.Add(time.Minute), first.Add(time.Minute + QuietTimeout)},
		{"root grace is capped at the max hold", true, first.Add(MaxTraceHold - time.Second), first.Add(MaxTraceHold)},
		{"quiet timeout is capped at the max hold", false, first.Add(MaxTraceHold - time.Minute), first.Add(MaxTraceHold)},
		{"past the max hold the trace is due at once", true, first.Add(MaxTraceHold + time.Hour), first.Add(MaxTraceHold)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveAt(first, tc.rootSeen, tc.now); !got.Equal(tc.want) {
				t.Fatalf("resolveAt = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestFactIsRoot(t *testing.T) {
	parent := [8]byte{9}
	cases := []struct {
		name string
		fact Fact
		want bool
	}{
		{"span without a parent", Fact{Kind: KindSpan}, true},
		{"span with a remote parent", Fact{Kind: KindSpan, ParentSpanID: parent, RemoteParent: true}, true},
		{"span with a local parent", Fact{Kind: KindSpan, ParentSpanID: parent}, false},
		{"log record without a parent", Fact{Kind: KindLog}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.fact.isRoot(); got != tc.want {
				t.Fatalf("isRoot = %v, want %v", got, tc.want)
			}
		})
	}
}

// A malformed batch is refused before any SQL runs, so a store with no
// pool is enough.
func TestStageRefusesMalformedBatches(t *testing.T) {
	good := func() TraceBatch {
		return TraceBatch{
			Key:     TraceKey{TokenKey: "tok", TraceID: [16]byte{1}},
			Source:  "pydantic_ai",
			Records: []Record{{Fact: Fact{SpanID: [8]byte{1}, Kind: KindSpan}}},
		}
	}
	cases := []struct {
		name   string
		mutate func(*TraceBatch)
		want   string
	}{
		{"no token key", func(b *TraceBatch) { b.Key.TokenKey = "" }, "token key"},
		{"zero trace id", func(b *TraceBatch) { b.Key.TraceID = [16]byte{} }, "trace id"},
		{"no source", func(b *TraceBatch) { b.Source = "" }, "source"},
		{"bad resource", func(b *TraceBatch) { b.Resource = json.RawMessage("{") }, "resource"},
		{"zero span id", func(b *TraceBatch) { b.Records[0].SpanID = [8]byte{} }, "span id"},
		{"unknown kind", func(b *TraceBatch) { b.Records[0].Kind = 3 }, "kind"},
		{"bad meta", func(b *TraceBatch) { b.Records[0].Meta = json.RawMessage("nope") }, "meta"},
		{"bad content", func(b *TraceBatch) { b.Records[0].Content = json.RawMessage("[") }, "content"},
	}
	// Validation runs before any statement, so no database is needed.
	s := &Store{now: time.Now}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := good()
			tc.mutate(&b)
			_, err := s.Stage(context.Background(), []TraceBatch{b})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Stage error = %v, want one naming %q", err, tc.want)
			}
		})
	}
}

func TestStageNothingIsANoOp(t *testing.T) {
	res, err := (&Store{now: time.Now}).Stage(context.Background(), nil)
	if err != nil || res != (StageResult{}) {
		t.Fatalf("Stage(nil) = %+v, %v; want a zero result and no error", res, err)
	}
}

func TestMarkAssembledRefusesUnknownReason(t *testing.T) {
	_, err := (&Store{now: time.Now}).MarkAssembled(context.Background(), "me", TraceKey{}, 0, "late", nil)
	if err == nil || !strings.Contains(err.Error(), "late") {
		t.Fatalf("MarkAssembled error = %v, want one naming the reason", err)
	}
}

func TestClaimDueNeedsAnOwner(t *testing.T) {
	if _, err := (&Store{now: time.Now}).ClaimDue(context.Background(), ""); err == nil {
		t.Fatal("ClaimDue with no owner succeeded")
	}
}

func TestLoadedTraceUnassembled(t *testing.T) {
	lt := LoadedTrace{Facts: []StagedFact{
		{Fact: Fact{SpanID: [8]byte{1}, Kind: KindSpan}, Assembled: true},
		{Fact: Fact{SpanID: [8]byte{2}, Kind: KindSpan}},
		{Fact: Fact{SpanID: [8]byte{2}, Kind: KindLog}},
	}}
	got := lt.Unassembled()
	want := []FactKey{{SpanID: [8]byte{2}, Kind: KindSpan}, {SpanID: [8]byte{2}, Kind: KindLog}}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("Unassembled = %v, want %v", got, want)
	}
}
