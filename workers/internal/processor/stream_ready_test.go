package processor

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

// captureLogs routes the default logger into a buffer for the test.
func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &buf
}

func TestStreamReadyWarnsWhenSequencesWereForgotten(t *testing.T) {
	logs := captureLogs(t)
	var asked uint64
	p := &Processor{clearSequences: func(_ context.Context, lastSeq uint64) (int64, error) {
		asked = lastSeq
		return 3, nil
	}}
	if err := p.StreamReady(context.Background(), 42); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if asked != 42 {
		t.Fatalf("writer asked to clear above %d, want 42", asked)
	}
	if !strings.Contains(logs.String(), "forgot session sequences") || !strings.Contains(logs.String(), "rows=3") {
		t.Fatalf("forgotten sequences were not reported: %q", logs.String())
	}
}

func TestStreamReadyStaysQuietWhenNothingWasForgotten(t *testing.T) {
	logs := captureLogs(t)
	p := &Processor{clearSequences: func(context.Context, uint64) (int64, error) { return 0, nil }}
	if err := p.StreamReady(context.Background(), 42); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if logs.Len() != 0 {
		t.Fatalf("a healthy stream logged: %q", logs.String())
	}
}

func TestStreamReadyReportsTheWriterError(t *testing.T) {
	boom := errors.New("boom")
	p := &Processor{clearSequences: func(context.Context, uint64) (int64, error) { return 0, boom }}
	if err := p.StreamReady(context.Background(), 42); !errors.Is(err, boom) {
		t.Fatalf("error = %v, want %v", err, boom)
	}
}

func TestAfterSessionEndForgetsPolicyStateOnlyWhenTheSessionClosed(t *testing.T) {
	pe := NewPolicyEvaluator(nil)
	pe.fired["sid"] = map[string]bool{"warn": true}
	p := &Processor{policy: pe}

	p.afterSessionEnd("sid", false)
	if _, ok := pe.fired["sid"]; !ok {
		t.Fatal("a session_end that closed nothing forgot the live session's fired directives")
	}
	p.afterSessionEnd("sid", true)
	if _, ok := pe.fired["sid"]; ok {
		t.Fatal("the closing session_end left the fired directives behind")
	}
}
