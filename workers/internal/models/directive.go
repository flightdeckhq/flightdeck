package models

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// Directive mirrors the directives table.
type Directive struct {
	ID             pgtype.UUID      `json:"id" db:"id"`
	SessionID      pgtype.UUID      `json:"session_id,omitempty" db:"session_id"`
	Flavor         pgtype.Text      `json:"flavor,omitempty" db:"flavor"`
	Action         string           `json:"action" db:"action"`
	Reason         pgtype.Text      `json:"reason,omitempty" db:"reason"`
	GracePeriodMs  int              `json:"grace_period_ms" db:"grace_period_ms"`
	IssuedBy       string           `json:"issued_by" db:"issued_by"`
	IssuedAt       time.Time        `json:"issued_at" db:"issued_at"`
	DeliveredAt    pgtype.Timestamp `json:"delivered_at,omitempty" db:"delivered_at"`
	AcknowledgedAt pgtype.Timestamp `json:"acknowledged_at,omitempty" db:"acknowledged_at"`
}
