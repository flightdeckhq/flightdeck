// Package writer -- notify.go sends Postgres NOTIFY for real-time dashboard push.
package writer

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

const notifyChannel = "flightdeck_fleet"

// NotifyFleetChange sends a Postgres NOTIFY on the flightdeck_fleet channel.
// The query API hub LISTENs on this channel to broadcast WebSocket updates.
func NotifyFleetChange(ctx context.Context, pool *pgxpool.Pool, sessionID, eventType string) error {
	payload := fmt.Sprintf(`{"session_id":"%s","event_type":"%s"}`, sessionID, eventType)
	_, err := pool.Exec(ctx, fmt.Sprintf("NOTIFY %s, '%s'", notifyChannel, payload))
	if err != nil {
		return fmt.Errorf("notify %s: %w", notifyChannel, err)
	}
	return nil
}
