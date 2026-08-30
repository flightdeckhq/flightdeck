// Package writer -- notify.go sends Postgres NOTIFY for real-time dashboard push.
package writer

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// fleetNotifyPayload is the wire format of every NOTIFY sent on the
// flightdeck_fleet channel. EventID was added (D108) to eliminate
// the hub NOTIFY->SELECT race: the hub used to re-query
// GetSessionEvents and pick the tail, which broke under tight
// paired events (post_call followed by tool_call inside ~200 ms,
// common after D107's PostToolUse flush) because the second event
// would commit before the hub's query ran and clobber the first
// event in the broadcast. Carrying the event id directly lets the
// hub do a deterministic single-row fetch. See D108 in DECISIONS.md
// and api/internal/ws/hub.go for the reader side of the contract.
type fleetNotifyPayload struct {
	SessionID string `json:"session_id"`
	EventType string `json:"event_type"`
	EventID   string `json:"event_id"`
}

const notifyChannel = "flightdeck_fleet"

// NotifyFleetChange sends a Postgres NOTIFY on the flightdeck_fleet channel.
// The query API hub LISTENs on this channel to broadcast WebSocket updates.
// eventID must be the id returned by the preceding InsertEvent call so the
// hub can fetch exactly the event that triggered the NOTIFY (D108).
func NotifyFleetChange(ctx context.Context, pool *pgxpool.Pool, sessionID, eventType, eventID string) error {
	data, err := json.Marshal(fleetNotifyPayload{
		SessionID: sessionID,
		EventType: eventType,
		EventID:   eventID,
	})
	if err != nil {
		return fmt.Errorf("marshal notify payload: %w", err)
	}
	// Use pg_notify($1,$2) with bound parameters rather than a
	// string-built NOTIFY. The payload embeds session_id/event_type,
	// and a bound parameter cannot break out of the SQL statement even
	// if an upstream validation is ever relaxed (defense in depth).
	payload := string(data)
	_, err = pool.Exec(ctx, "SELECT pg_notify($1, $2)", notifyChannel, payload)
	if err != nil {
		return fmt.Errorf("notify %s: %w", notifyChannel, err)
	}
	return nil
}
