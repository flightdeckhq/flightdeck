// Package writer -- notify.go sends Postgres NOTIFY for real-time dashboard push.
package writer

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

type fleetNotifyPayload struct {
	SessionID string `json:"session_id"`
	EventType string `json:"event_type"`
}

const notifyChannel = "flightdeck_fleet"

// NotifyFleetChange sends a Postgres NOTIFY on the flightdeck_fleet channel.
// The query API hub LISTENs on this channel to broadcast WebSocket updates.
func NotifyFleetChange(ctx context.Context, pool *pgxpool.Pool, sessionID, eventType string) error {
	data, err := json.Marshal(fleetNotifyPayload{SessionID: sessionID, EventType: eventType})
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
