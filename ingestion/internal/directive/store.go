// Package directive provides fast lookup for pending control-plane directives.
package directive

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Directive is the response-envelope payload returned to the sensor.
type Directive struct {
	ID            string `json:"id"`
	Action        string `json:"action"`
	Reason        string `json:"reason"`
	GracePeriodMs int    `json:"grace_period_ms"`
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
		RETURNING id::text, action, COALESCE(reason, ''), grace_period_ms
	`, time.Now().UTC(), sessionID).Scan(&d.ID, &d.Action, &d.Reason, &d.GracePeriodMs)

	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("lookup pending directive: %w", err)
	}
	return &d, nil
}
