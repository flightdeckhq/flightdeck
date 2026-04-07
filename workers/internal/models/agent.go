// Package models contains Go structs mirroring all Postgres tables.
package models

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// Agent mirrors the agents table.
// Flavor is the persistent identity -- the agent's role in the fleet.
type Agent struct {
	Flavor       string           `json:"flavor" db:"flavor"`
	AgentType    string           `json:"agent_type" db:"agent_type"`
	FirstSeen    time.Time        `json:"first_seen" db:"first_seen"`
	LastSeen     time.Time        `json:"last_seen" db:"last_seen"`
	SessionCount int              `json:"session_count" db:"session_count"`
	PolicyID     pgtype.UUID      `json:"policy_id,omitempty" db:"policy_id"`
}
