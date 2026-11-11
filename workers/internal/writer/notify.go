// Package writer -- notify.go announces committed changes on the storage
// Bus for real-time dashboard push.
package writer

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/workers/internal/logcap"
)

// fleetNotifyPayload is the wire format of every notification sent on
// the flightdeck_fleet channel. EventID eliminates the hub
// notify->SELECT race: without it the hub would re-query
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

// notifyChannel is the Bus channel the query API hub subscribes to.
// On Postgres it is the NOTIFY channel of the same name; on SQLite the
// in-process bus the services share.
const notifyChannel = storage.ChannelFleet

// NotifyFleetChange publishes one flightdeck_fleet notification. The
// query API hub subscribes to this channel to broadcast WebSocket
// updates. eventID must be the id returned by the preceding InsertEvent
// call so the hub can fetch exactly the event that triggered the
// notification.
func NotifyFleetChange(ctx context.Context, bus storage.Bus, sessionID, eventType, eventID string) error {
	return notifyFleet(ctx, bus, []fleetNotifyPayload{{
		SessionID: sessionID,
		EventType: eventType,
		EventID:   eventID,
	}})
}

// notifyFleet publishes one flightdeck_fleet notification per payload,
// in order. The payload is a JSON document the bus carries whole, so
// nothing in it can alter a statement. The publishes run on their own,
// after the write they announce has committed, so the hub never
// re-reads a session before the change is visible. Every payload is
// attempted; the first failure is returned.
func notifyFleet(ctx context.Context, bus storage.Bus, payloads []fleetNotifyPayload) error {
	var first error
	for _, p := range payloads {
		data, err := json.Marshal(p)
		if err != nil {
			return fmt.Errorf("marshal notify payload: %w", err)
		}
		if err := bus.Publish(ctx, notifyChannel, string(data)); err != nil && first == nil {
			first = fmt.Errorf("notify %s: %w", notifyChannel, err)
		}
	}
	return first
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
	if err := notifyFleet(ctx, w.bus, payloads); err != nil {
		slog.Warn("notify of committed session change failed",
			"change", what, "sessions", len(payloads), "err", logcap.Err(err))
	}
}
