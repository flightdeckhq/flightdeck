// Package writer -- notify.go sends Postgres NOTIFY for real-time dashboard push.
package writer

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/flightdeckhq/flightdeck/workers/internal/logcap"
	"github.com/jackc/pgx/v5/pgxpool"
)

// fleetNotifyPayload is the wire format of every NOTIFY sent on the
// flightdeck_fleet channel. EventID eliminates the hub
// NOTIFY->SELECT race: without it the hub would re-query
// GetSessionEvents and pick the tail, which breaks under tight
// paired events (post_call followed by tool_call inside ~200 ms,
// common after the plugin's PostToolUse flush) because the second
// event commits before the hub's query runs and clobbers the first
// event in the broadcast. Carrying the event id directly lets the
// hub do a deterministic single-row fetch. See api/internal/ws/hub.go
// for the reader side of the contract.
//
// EventType and EventID are empty for a state-only change: the
// session row changed (the reconciler marked it stale or lost, or a
// child's event revived it) and no event was written. The hub then
// broadcasts the session it re-reads, with no event.
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

// notifyFleet sends one flightdeck_fleet notification per payload in a
// single statement, with the payloads bound as a text array (the same
// defense as NotifyFleetChange's bound parameters). The statement runs
// on its own, after the write it announces has committed, so the hub
// never re-reads a session before the change is visible.
func notifyFleet(ctx context.Context, q querier, payloads []fleetNotifyPayload) error {
	if len(payloads) == 0 {
		return nil
	}
	texts := make([]string, len(payloads))
	for i, p := range payloads {
		data, err := json.Marshal(p)
		if err != nil {
			return fmt.Errorf("marshal notify payload: %w", err)
		}
		texts[i] = string(data)
	}
	if _, err := q.Exec(ctx,
		"SELECT pg_notify($1, p) FROM unnest($2::text[]) AS p",
		notifyChannel, texts,
	); err != nil {
		return fmt.Errorf("notify %s: %w", notifyChannel, err)
	}
	return nil
}

// stateChanges returns the state-only payload of each distinct session
// id across the lists, in order: a session the reconciler marks stale
// and then lost in one pass is announced once, and the hub's re-read
// shows where it ended up.
func stateChanges(idLists ...[]string) []fleetNotifyPayload {
	seen := make(map[string]struct{})
	var payloads []fleetNotifyPayload
	for _, ids := range idLists {
		for _, id := range ids {
			if _, dup := seen[id]; dup {
				continue
			}
			seen[id] = struct{}{}
			payloads = append(payloads, fleetNotifyPayload{SessionID: id})
		}
	}
	return payloads
}

// announce sends the notifications of a committed change. The change
// stands whether or not they go out: a failure is logged, the dashboard
// shows the change on its next fetch, and the state machine never
// depends on the notification channel.
func (w *Writer) announce(ctx context.Context, what string, payloads []fleetNotifyPayload) {
	if err := notifyFleet(ctx, w.pool, payloads); err != nil {
		slog.Warn("notify of committed session change failed",
			"change", what, "sessions", len(payloads), "err", logcap.Err(err))
	}
}
