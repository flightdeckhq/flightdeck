// Package ws provides a WebSocket hub that broadcasts Postgres NOTIFY
// events to all connected dashboard clients.
package ws

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
)

const notifyReconnectDelay = 3 * time.Second

const broadcastChannelBuffer = 256

// Fleet update message types broadcast to dashboard WebSocket clients.
// These appear in the ``type`` field of fleetUpdate / directivesChanged
// payloads and are the wire contract with dashboard/src/store/fleet.ts.
const (
	msgTypeSessionStart     = "session_start"
	msgTypeSessionEnd       = "session_end"
	msgTypeSessionUpdate    = "session_update"
	msgTypeDirectivesChange = "directives_changed"
)

// Client is a single WebSocket connection managed by the Hub.
type Client struct {
	conn *websocket.Conn
	send chan []byte
}

// Hub manages WebSocket client connections and broadcasts messages.
type Hub struct {
	clients    map[*Client]struct{}
	register   chan *Client
	unregister chan *Client
	broadcast  chan []byte
	mu         sync.RWMutex
	store      store.Querier
}

// NewHub creates a Hub with access to the store for enriching NOTIFY payloads.
func NewHub(s store.Querier) *Hub {
	return &Hub{
		clients:    make(map[*Client]struct{}),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		broadcast:  make(chan []byte, broadcastChannelBuffer),
		store:      s,
	}
}

// closeAndRemove closes the client's send channel and removes it
// from the hub map. Phase 4.5 L-19: extracted helper so every close
// path follows the same map-presence-then-close pattern. Caller
// MUST hold ``h.mu`` (write lock) -- the helper does not acquire
// the lock so it composes cleanly with multi-client iteration in
// the broadcast branch.
func (h *Hub) closeAndRemove(c *Client) {
	if _, ok := h.clients[c]; !ok {
		return
	}
	close(c.send)
	delete(h.clients, c)
}

// Run starts the hub event loop. Blocks until ctx is cancelled.
//
// Run is a single goroutine; every map mutation and channel close
// happens on this goroutine, serialized by the select. The h.mu
// write lock additionally protects ClientCount readers from
// observing torn state. This invariant is what makes the
// "double-close channel" class of bug structurally impossible
// here -- see audit-phase-4.5.md L-19 for the trace.
func (h *Hub) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			h.mu.Lock()
			for c := range h.clients {
				h.closeAndRemove(c)
			}
			h.mu.Unlock()
			return

		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = struct{}{}
			h.mu.Unlock()

		case client := <-h.unregister:
			h.mu.Lock()
			h.closeAndRemove(client)
			h.mu.Unlock()

		case msg := <-h.broadcast:
			h.mu.Lock()
			for client := range h.clients {
				select {
				case client.send <- msg:
				default:
					// Client send buffer full -- close and remove
					h.closeAndRemove(client)
				}
			}
			h.mu.Unlock()
		}
	}
}

// Register adds a WebSocket connection to the hub.
func (h *Hub) Register(conn *websocket.Conn) *Client {
	client := &Client{
		conn: conn,
		send: make(chan []byte, 64),
	}
	h.register <- client
	return client
}

// Unregister removes a client from the hub.
func (h *Hub) Unregister(client *Client) {
	h.unregister <- client
}

// ClientCount returns the number of connected clients (test helper).
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

// Broadcast sends a message to all connected clients.
func (h *Hub) Broadcast(msg []byte) {
	h.broadcast <- msg
}

// WritePump sends messages from the client's send channel to the WebSocket.
// Runs in its own goroutine per client.
func WritePump(client *Client) {
	defer func() {
		_ = client.conn.Close()
	}()

	for msg := range client.send {
		if err := client.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			slog.Debug("write pump error", "err", err)
			return
		}
	}
}

// notifyPayload is the raw payload from Postgres NOTIFY. EventID was
// added to give the hub a deterministic pointer to the triggering
// event: before D108, listenOnce called GetSessionEvents and picked
// the tail, which raced with concurrent inserts whenever paired
// events (post_call + tool_call within ~200 ms, common after D107's
// PostToolUse flush) committed close together. See D108 in
// DECISIONS.md and workers/internal/writer/notify.go for the writer
// side of the contract.
type notifyPayload struct {
	SessionID string `json:"session_id"`
	EventType string `json:"event_type"`
	EventID   string `json:"event_id"`
}

// fleetUpdate is the enriched payload broadcast to WebSocket clients.
type fleetUpdate struct {
	Type      string       `json:"type"`
	Session   *store.Session `json:"session"`
	LastEvent *store.Event   `json:"last_event,omitempty"`
}

// listenOnce acquires a connection, issues LISTEN, and blocks reading
// notifications until an error occurs or ctx is cancelled. Phase 4.5
// M-24: issues UNLISTEN before release so a recycled pool conn does
// not surface stale subscriptions to an unrelated caller.
func (h *Hub) listenOnce(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire conn for LISTEN: %w", err)
	}
	defer func() {
		// Use a fresh background context with a small timeout: the
		// caller's ctx is typically already cancelled when we hit
		// this path, and UNLISTEN over a cancelled context would
		// no-op. We want the cleanup to land regardless.
		uctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if _, uErr := conn.Exec(uctx, "UNLISTEN "+store.NotifyChannel); uErr != nil {
			slog.Debug("UNLISTEN failed during release", "err", uErr)
		}
		conn.Release()
	}()

	_, err = conn.Exec(ctx, "LISTEN "+store.NotifyChannel)
	if err != nil {
		return fmt.Errorf("LISTEN failed: %w", err)
	}

	slog.Info("listening on Postgres NOTIFY", "channel", store.NotifyChannel)

	for {
		notification, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			return fmt.Errorf("wait for notification: %w", err)
		}

		// Special-case the directive-registered sentinel emitted by
		// store.RegisterDirectives. It is a literal non-JSON string with
		// no session_id, so JSON-parsing it would spam the warn log on
		// every directive registration. Re-broadcast as the typed
		// directives_changed message so future client code can react to
		// directive registration in real time.
		if notification.Payload == store.NotifyDirectiveRegistered {
			msg, _ := json.Marshal(map[string]string{"type": msgTypeDirectivesChange})
			h.Broadcast(msg)
			continue
		}

		// Parse the thin NOTIFY payload to get session_id
		var np notifyPayload
		if jsonErr := json.Unmarshal([]byte(notification.Payload), &np); jsonErr != nil {
			slog.Warn("invalid NOTIFY payload", "payload", notification.Payload, "err", jsonErr)
			continue
		}

		if np.SessionID == "" {
			slog.Warn("NOTIFY payload missing session_id", "payload", notification.Payload)
			continue
		}

		// Fetch the full session from the store
		session, fetchErr := h.store.GetSession(ctx, np.SessionID)
		if fetchErr != nil {
			slog.Warn("failed to fetch session for WS broadcast", "session_id", np.SessionID, "err", fetchErr)
			continue
		}
		if session == nil {
			slog.Debug("session not found for WS broadcast", "session_id", np.SessionID)
			continue
		}

		// Fetch exactly the event that triggered this NOTIFY. A
		// direct GetEvent(event_id) is O(1) (indexed PK lookup)
		// rather than O(N) over the session's event history, and
		// eliminates the NOTIFY->SELECT race where
		// GetSessionEvents + tail would return a later event when
		// paired writes committed in quick succession. See D108.
		var lastEvent *store.Event
		if np.EventID != "" {
			event, evtErr := h.store.GetEvent(ctx, np.EventID)
			if evtErr != nil {
				slog.Warn("failed to fetch event for WS broadcast",
					"event_id", np.EventID,
					"session_id", np.SessionID,
					"err", evtErr,
				)
				continue
			}
			if event == nil {
				// Possible when the NOTIFY arrives at the hub
				// before the insert transaction has committed
				// (uncommon but valid). Skip the broadcast; the
				// client has no update to apply, and the event
				// will be picked up by the next bulk fetch or
				// drawer open.
				slog.Warn("event not found for WS broadcast",
					"event_id", np.EventID,
					"session_id", np.SessionID,
				)
				continue
			}
			lastEvent = event
		}

		// Determine update type from event_type
		var updateType string
		switch np.EventType {
		case msgTypeSessionStart:
			updateType = msgTypeSessionStart
		case msgTypeSessionEnd:
			updateType = msgTypeSessionEnd
		default:
			updateType = msgTypeSessionUpdate
		}

		// Build and broadcast the enriched payload. fleetUpdate is
		// composed of typed *store.Session and *store.Event fields
		// whose JSON tags use only Go-marshalable primitives, so
		// json.Marshal cannot fail in practice. Phase 4.5 L-8: log
		// at debug rather than error and continue -- a real failure
		// here would indicate corrupted db state surfacing through
		// the typed structs and would already have been logged
		// upstream.
		msg, marshalErr := json.Marshal(fleetUpdate{
			Type:      updateType,
			Session:   session,
			LastEvent: lastEvent,
		})
		if marshalErr != nil {
			slog.Debug("marshal fleet update (unexpected; typed structs)", "err", marshalErr)
			continue
		}

		h.Broadcast(msg)
	}
}

// ListenNotify subscribes to the Postgres NOTIFY channel with automatic
// reconnection on failure. Blocks until ctx is cancelled.
func (h *Hub) ListenNotify(ctx context.Context, pool *pgxpool.Pool) {
	for {
		if ctx.Err() != nil {
			return
		}
		if err := h.listenOnce(ctx, pool); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Error("NOTIFY listener error, reconnecting", "delay", notifyReconnectDelay, "err", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(notifyReconnectDelay):
			}
		}
	}
}
