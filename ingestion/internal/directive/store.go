// Package directive provides fast lookup for pending control-plane directives.
package directive

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Directive is the response-envelope payload returned to the sensor.
type Directive struct {
	ID            string           `json:"id"`
	Action        string           `json:"action"`
	Reason        string           `json:"reason"`
	DegradeTo     *string          `json:"degrade_to,omitempty"`
	GracePeriodMs int              `json:"grace_period_ms"`
	Payload       *json.RawMessage `json:"payload,omitempty"`
}

// Store reads and marks directives in Postgres.
type Store struct {
	pool *pgxpool.Pool
}

// NewStore creates a directive Store.
func NewStore(pool *pgxpool.Pool) *Store {
	return &Store{pool: pool}
}

// LookupPending returns the oldest undelivered directive for a session.
// Returns nil if none exist. Marks the directive as delivered atomically.
func (s *Store) LookupPending(ctx context.Context, sessionID string) (*Directive, error) {
	var d Directive
	err := s.pool.QueryRow(ctx, `
		UPDATE directives
		SET delivered_at = $1
		WHERE id = (
			SELECT id FROM directives
			WHERE (session_id = $2::uuid OR flavor = (
				SELECT flavor FROM sessions WHERE session_id = $2::uuid
			))
			AND delivered_at IS NULL
			ORDER BY issued_at ASC
			LIMIT 1
		)
		RETURNING id::text, action, COALESCE(reason, ''), degrade_to, grace_period_ms, payload
	`, time.Now().UTC(), sessionID).Scan(&d.ID, &d.Action, &d.Reason, &d.DegradeTo, &d.GracePeriodMs, &d.Payload)

	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("lookup pending directive: %w", err)
	}
	return &d, nil
}
