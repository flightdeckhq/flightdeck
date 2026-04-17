package models

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// Event mirrors the events table (metadata only -- no prompt content inline).
type Event struct {
	ID                  pgtype.UUID `json:"id" db:"id"`
	SessionID           pgtype.UUID `json:"session_id" db:"session_id"`
	Flavor              string      `json:"flavor" db:"flavor"`
	EventType           string      `json:"event_type" db:"event_type"`
	Model               pgtype.Text `json:"model,omitempty" db:"model"`
	TokensInput         pgtype.Int4 `json:"tokens_input,omitempty" db:"tokens_input"`
	TokensOutput        pgtype.Int4 `json:"tokens_output,omitempty" db:"tokens_output"`
	TokensTotal         pgtype.Int4 `json:"tokens_total,omitempty" db:"tokens_total"`
	TokensCacheRead     pgtype.Int8 `json:"tokens_cache_read" db:"tokens_cache_read"`         // D098
	TokensCacheCreation pgtype.Int8 `json:"tokens_cache_creation" db:"tokens_cache_creation"` // D098
	LatencyMs           pgtype.Int4 `json:"latency_ms,omitempty" db:"latency_ms"`
	ToolName            pgtype.Text `json:"tool_name,omitempty" db:"tool_name"`
	HasContent          bool        `json:"has_content" db:"has_content"`
	Payload             []byte      `json:"payload,omitempty" db:"payload"`
	OccurredAt          time.Time   `json:"occurred_at" db:"occurred_at"`
}
