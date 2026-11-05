package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// GetSession carries the session's stored capture posture
// (sessions.capture_prompts) as it is: true, false, or null while no
// session_start has declared it. A capture-on run that stored no
// content is the case it exists for: capture_enabled (whether any event
// stored content) is false there too, so only the posture tells it from
// a capture-off run.
func TestGetSession_CapturePrompts(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	agentID := randomUUID(t)
	seedAgent(t, s, agentID, now.Add(-time.Hour), now, 3, 0)

	on, off, undeclared := randomUUID(t), randomUUID(t), randomUUID(t)
	flavor := "test-capture-prompts-" + agentID[:8]
	for _, run := range []struct {
		id      string
		capture *bool
	}{
		{on, boolPtr(true)},
		{off, boolPtr(false)},
		{undeclared, nil},
	} {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO sessions (
				session_id, agent_id, flavor, state,
				started_at, last_seen_at, tokens_used,
				agent_type, client_type, capture_prompts
			) VALUES ($1::uuid, $2::uuid, $3, 'closed', $4, $4, 0, 'production', 'otlp', $5)
		`, run.id, agentID, flavor, now.Add(-time.Minute), run.capture); err != nil {
			t.Fatalf("seed session: %v", err)
		}
	}

	for _, tc := range []struct {
		name, id string
		want     *bool
		wantJSON string
	}{
		{"capture on, no content stored", on, boolPtr(true), `"capture_prompts":true`},
		{"capture off", off, boolPtr(false), `"capture_prompts":false`},
		{"posture not declared yet", undeclared, nil, `"capture_prompts":null`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := s.GetSession(ctx, tc.id)
			if err != nil || got == nil {
				t.Fatalf("GetSession: %v, %v", got, err)
			}
			if (got.CapturePrompts == nil) != (tc.want == nil) ||
				(got.CapturePrompts != nil && *got.CapturePrompts != *tc.want) {
				t.Errorf("CapturePrompts = %v, want %v", deref(got.CapturePrompts), deref(tc.want))
			}
			// No event stored content, so capture_enabled is false in
			// every case: the posture is the only thing that differs.
			if got.CaptureEnabled {
				t.Errorf("CaptureEnabled = true, want false")
			}
			raw, err := json.Marshal(got)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if !strings.Contains(string(raw), tc.wantJSON) {
				t.Errorf("JSON %s lacks %s", raw, tc.wantJSON)
			}
		})
	}
}

func boolPtr(b bool) *bool { return &b }

func deref(b *bool) any {
	if b == nil {
		return nil
	}
	return *b
}
