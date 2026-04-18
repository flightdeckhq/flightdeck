// Package writer -- notify.go sends Postgres NOTIFY for real-time dashboard push.
package writer

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// fleetNotifyPayload is the wire format of every NOTIFY sent on the
// flightdeck_fleet channel. EventID was added to eliminate the hub
// NOTIFY->SELECT race: the hub used to re-query GetSessionEvents and
// pick the tail, which broke under tight paired events (post_call
// followed by tool_call inside ~200 ms, common after b63ef8e) because
// the second event would commit before the hub's query ran and
// clobber the first event in the broadcast. Carrying the event id
// directly lets the hub do a deterministic single-row fetch.
type fleetNotifyPayload struct {
	SessionID string `json:"session_id"`
	EventType string `json:"event_type"`
	EventID   string `json:"event_id"`
}

const notifyChannel = "flightdeck_fleet"

// NotifyFleetChange sends a Postgres NOTIFY on the flightdeck_fleet channel.
// The query API hub LISTENs on this channel to broadcast WebSocket updates.
// eventID must be the id returned by the preceding InsertEvent call so the
// hub can fetch exactly the event that triggered the NOTIFY.
func NotifyFleetChange(ctx context.Context, pool *pgxpool.Pool, sessionID, eventType, eventID string) error {
	data, err := json.Marshal(fleetNotifyPayload{
		SessionID: sessionID,
		EventType: eventType,
		EventID:   eventID,
	})
	if err != nil {
		return fmt.Errorf("marshal notify payload: %w", err)
	}
	payload := string(data)
	_, err = pool.Exec(ctx, fmt.Sprintf("NOTIFY %s, '%s'", notifyChannel, payload))
	if err != nil {
		return fmt.Errorf("notify %s: %w", notifyChannel, err)
	}
	return nil
}
