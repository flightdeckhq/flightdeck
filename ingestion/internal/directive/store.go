// Package directive provides fast lookup for pending control-plane
// directives. It reads and marks directives through the storage
// boundary, so it runs on SQLite and Postgres alike: its one statement
// is the common subset of both dialects.
package directive

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
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

// Store reads and marks directives.
type Store struct {
	db *storage.DB
}

// NewStore creates a directive Store.
func NewStore(db *storage.DB) *Store {
	return &Store{db: db}
}

// queryTakePending marks the oldest undelivered directive addressed to
// the session, or to its flavor with no session, delivered and returns
// it. The id is read as text on both backends (CAST is a no-op on
// SQLite, where the column is text) and the session id is bound as
// text, which Postgres compares against its uuid column. The statement
// is one UPDATE, so two lookups for the same session cannot both take
// the same row: the second finds delivered_at set.
const queryTakePending = `
	UPDATE directives
	SET delivered_at = $1
	WHERE id = (
		SELECT id FROM directives
		WHERE (session_id = $2 OR (session_id IS NULL AND flavor = (
			SELECT flavor FROM sessions WHERE session_id = $2
		)))
		AND delivered_at IS NULL
		ORDER BY issued_at ASC
		LIMIT 1
	)
	RETURNING CAST(id AS TEXT), action, COALESCE(reason, ''), degrade_to, grace_period_ms, payload`

// LookupPending returns the oldest undelivered directive for a session:
// one addressed to the session, or one addressed to its flavor with no
// session. A row for another session of the same flavor is never
// returned, since that session's own lookup must take it. Returns nil
// if none exist. Marks the directive as delivered atomically.
func (s *Store) LookupPending(ctx context.Context, sessionID string) (*Directive, error) {
	var (
		d       Directive
		payload []byte
	)
	// Lower case: the canonical form the SQLite CHECK enforces, and the
	// one Postgres' uuid type normalises to; the handlers accept hex
	// digits of either case.
	err := s.db.QueryRowContext(ctx, queryTakePending, time.Now().UTC(), strings.ToLower(sessionID)).
		Scan(&d.ID, &d.Action, &d.Reason, &d.DegradeTo, &d.GracePeriodMs, &payload)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("lookup pending directive: %w", err)
	}
	if payload != nil {
		raw := json.RawMessage(payload)
		d.Payload = &raw
	}
	return &d, nil
}
