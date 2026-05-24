package store

import (
	"context"
	"testing"
	"time"
)

// TestGetSessions_AttachmentCount exercises the attachment_count
// correlated-subquery column added for the agent drawer Runs-tab
// attached pill. Seeds one agent with two sessions — one
// re-attached three times, one never re-attached — and asserts
// the listing projects the count per row.
func TestGetSessions_AttachmentCount(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)

	agentID := randomUUID(t)
	seedAgent(t, s, agentID, now.Add(-time.Hour), now.Add(-10*time.Minute), 2, 200)

	attached := randomUUID(t)
	lone := randomUUID(t)
	flavor := "test-attachment-count-" + randomUUID(t)[:8]

	for _, sid := range []string{attached, lone} {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO sessions (
				session_id, agent_id, flavor, state,
				started_at, last_seen_at, tokens_used,
				agent_type, client_type
			) VALUES (
				$1::uuid, $2::uuid, $3, 'closed',
				$4, $4, 100,
				'coding', 'flightdeck_sensor'
			)
		`, sid, agentID, flavor, now.Add(-30*time.Minute)); err != nil {
			t.Fatalf("seed session: %v", err)
		}
	}

	// Three re-attachments for the first session; none for the second.
	for i := 0; i < 3; i++ {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO session_attachments (session_id, attached_at)
			VALUES ($1::uuid, $2)
		`, attached, now.Add(time.Duration(-25+i)*time.Minute)); err != nil {
			t.Fatalf("seed attachment %d: %v", i, err)
		}
	}

	resp, err := s.GetSessions(ctx, SessionsParams{
		From:    now.Add(-2 * time.Hour),
		To:      now,
		AgentID: agentID,
		Limit:   100,
	})
	if err != nil {
		t.Fatalf("GetSessions: %v", err)
	}

	byID := make(map[string]int, len(resp.Sessions))
	for _, row := range resp.Sessions {
		byID[row.SessionID] = row.AttachmentCount
	}
	if got, ok := byID[attached]; !ok {
		t.Fatalf("re-attached session missing from listing")
	} else if got != 3 {
		t.Errorf("attached session attachment_count=%d, want 3", got)
	}
	if got, ok := byID[lone]; !ok {
		t.Fatalf("lone session missing from listing")
	} else if got != 0 {
		t.Errorf("lone session attachment_count=%d, want 0", got)
	}
}
