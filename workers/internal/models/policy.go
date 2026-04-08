package models

import (
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// Policy mirrors the token_policies table.
type Policy struct {
	ID                pgtype.UUID `json:"id" db:"id"`
	Scope             string      `json:"scope" db:"scope"`
	ScopeValue        pgtype.Text `json:"scope_value,omitempty" db:"scope_value"`
	WarnAtPct         int         `json:"warn_at_pct" db:"warn_at_pct"`
	DegradeAtPct      int         `json:"degrade_at_pct" db:"degrade_at_pct"`
	DegradeTo         pgtype.Text `json:"degrade_to,omitempty" db:"degrade_to"`
	BlockAtPct        int         `json:"block_at_pct" db:"block_at_pct"`
	TokenLimit        pgtype.Int4 `json:"token_limit,omitempty" db:"token_limit"`
	UnavailablePolicy string      `json:"unavailable_policy" db:"unavailable_policy"`
	CreatedAt         time.Time   `json:"created_at" db:"created_at"`
	UpdatedAt         time.Time   `json:"updated_at" db:"updated_at"`
}
