package models

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// EventContent mirrors the event_content table.
// Prompt content is stored separately from events and fetched on demand.
type EventContent struct {
	EventID      pgtype.UUID `json:"event_id" db:"event_id"`
	SessionID    pgtype.UUID `json:"session_id" db:"session_id"`
	Provider     string      `json:"provider" db:"provider"`
	Model        string      `json:"model" db:"model"`
	SystemPrompt pgtype.Text `json:"system_prompt,omitempty" db:"system_prompt"`
	Messages     []byte      `json:"messages" db:"messages"`
	Tools        []byte      `json:"tools,omitempty" db:"tools"`
	Response     []byte      `json:"response" db:"response"`
	CapturedAt   time.Time   `json:"captured_at" db:"captured_at"`
}
