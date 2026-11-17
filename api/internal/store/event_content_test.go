package store

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

// GetEventContent returns the system prompt as it is stored: a
// system_prompt as the string, a system_blocks as the list (each block's
// keys kept, cache_control included), and neither as null. The JSON the
// content endpoint writes carries the same value under system_prompt.
func TestGetEventContent_SystemAsStored(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		now := time.Now().UTC().Truncate(time.Millisecond)
		agentID := randomUUID(t)
		seedAgent(t, s, agentID, now.Add(-time.Hour), now, 1, 0)
		sessionID := randomUUID(t)
		if _, err := s.db.ExecContext(ctx, `
			INSERT INTO sessions (
				session_id, agent_id, flavor, state,
				started_at, last_seen_at, tokens_used,
				agent_type, client_type, capture_prompts
			) VALUES ($1, $2, $3, 'closed', $4, $4, 0, 'production', 'flightdeck_sensor', TRUE)
		`, sessionID, agentID, "test-system-blocks-"+agentID[:8], now.Add(-time.Minute)); err != nil {
			t.Fatalf("seed session: %v", err)
		}

		const blocks = `[{"type":"text","text":"You are terse.","cache_control":{"type":"ephemeral"}},{"type":"text","text":"Answer in one word."}]`
		for _, tc := range []struct {
			name     string
			text     any
			blocks   any
			want     any
			wantJSON string
		}{
			{"text", "You are terse.", nil, "You are terse.", `"You are terse."`},
			{"text that reads as JSON", `[{"type":"text"}]`, nil, `[{"type":"text"}]`, `"[{\"type\":\"text\"}]"`},
			{"blocks", nil, blocks, []any{
				map[string]any{"type": "text", "text": "You are terse.", "cache_control": map[string]any{"type": "ephemeral"}},
				map[string]any{"type": "text", "text": "Answer in one word."},
			}, `[{"cache_control":{"type":"ephemeral"},"text":"You are terse.","type":"text"},{"text":"Answer in one word.","type":"text"}]`},
			{"none", nil, nil, nil, `null`},
		} {
			t.Run(tc.name, func(t *testing.T) {
				eventID := randomUUID(t)
				if _, err := s.db.ExecContext(ctx, `
					INSERT INTO event_content (event_id, session_id, provider, model, system_prompt, system_blocks, messages, response)
					VALUES ($1, $2, 'anthropic', 'claude-haiku-4-5', $3, $4, '[]', '{}')
				`, eventID, sessionID, tc.text, tc.blocks); err != nil {
					t.Fatalf("seed content: %v", err)
				}
				got, err := s.GetEventContent(ctx, eventID)
				if err != nil || got == nil {
					t.Fatalf("GetEventContent: %v, %v", got, err)
				}
				if !reflect.DeepEqual(got.SystemPrompt, tc.want) {
					t.Errorf("SystemPrompt = %#v, want %#v", got.SystemPrompt, tc.want)
				}
				raw, err := json.Marshal(got)
				if err != nil {
					t.Fatalf("marshal: %v", err)
				}
				var body struct {
					SystemPrompt json.RawMessage `json:"system_prompt"`
				}
				if err := json.Unmarshal(raw, &body); err != nil {
					t.Fatalf("unmarshal: %v", err)
				}
				if string(body.SystemPrompt) != tc.wantJSON {
					t.Errorf("system_prompt JSON = %s, want %s", body.SystemPrompt, tc.wantJSON)
				}
			})
		}
	})
}
