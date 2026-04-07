package models

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// Session mirrors the sessions table.
// A session is one running instance of an agent (ephemeral identity).
type Session struct {
	SessionID  pgtype.UUID      `json:"session_id" db:"session_id"`
	Flavor     string           `json:"flavor" db:"flavor"`
	AgentType  string           `json:"agent_type" db:"agent_type"`
	Host       pgtype.Text      `json:"host" db:"host"`
	Framework  pgtype.Text      `json:"framework" db:"framework"`
	Model      pgtype.Text      `json:"model" db:"model"`
	State      string           `json:"state" db:"state"`
	StartedAt  time.Time        `json:"started_at" db:"started_at"`
	LastSeenAt time.Time        `json:"last_seen_at" db:"last_seen_at"`
	EndedAt    pgtype.Timestamp `json:"ended_at,omitempty" db:"ended_at"`
	TokensUsed int              `json:"tokens_used" db:"tokens_used"`
	TokenLimit pgtype.Int4      `json:"token_limit,omitempty" db:"token_limit"`
	Metadata   []byte           `json:"metadata,omitempty" db:"metadata"`
}
