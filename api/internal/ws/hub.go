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

const notifyChannel = "flightdeck_fleet"

const notifyReconnectDelay = 3 * time.Second

const broadcastChannelBuffer = 256

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

// Run starts the hub event loop. Blocks until ctx is cancelled.
func (h *Hub) Run(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			h.mu.Lock()
			for c := range h.clients {
				close(c.send)
				delete(h.clients, c)
			}
			h.mu.Unlock()
			return

		case client := <-h.register:
			h.mu.Lock()
			h.clients[client] = struct{}{}
			h.mu.Unlock()

		case client := <-h.unregister:
			h.mu.Lock()
			if _, ok := h.clients[client]; ok {
				close(client.send)
				delete(h.clients, client)
			}
			h.mu.Unlock()

		case msg := <-h.broadcast:
			h.mu.Lock()
			for client := range h.clients {
				select {
				case client.send <- msg:
				default:
					// Client send buffer full -- close and remove
					close(client.send)
					delete(h.clients, client)
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

// notifyPayload is the raw payload from Postgres NOTIFY.
type notifyPayload struct {
	SessionID string `json:"session_id"`
	EventType string `json:"event_type"`
}

// fleetUpdate is the enriched payload broadcast to WebSocket clients.
type fleetUpdate struct {
	Type      string       `json:"type"`
	Session   *store.Session `json:"session"`
	LastEvent *store.Event   `json:"last_event,omitempty"`
}

// listenOnce acquires a connection, issues LISTEN, and blocks reading
// notifications until an error occurs or ctx is cancelled.
func (h *Hub) listenOnce(ctx context.Context, pool *pgxpool.Pool) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire conn for LISTEN: %w", err)
	}
	defer conn.Release()

	_, err = conn.Exec(ctx, "LISTEN "+notifyChannel)
	if err != nil {
		return fmt.Errorf("LISTEN failed: %w", err)
	}

	slog.Info("listening on Postgres NOTIFY", "channel", notifyChannel)

	for {
		notification, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			return fmt.Errorf("wait for notification: %w", err)
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

		// Fetch the latest event for the live feed
		var lastEvent *store.Event
		events, evtErr := h.store.GetSessionEvents(ctx, np.SessionID)
		if evtErr == nil && len(events) > 0 {
			lastEvent = &events[len(events)-1]
		}

		// Determine update type from event_type
		var updateType string
		switch np.EventType {
		case "session_start":
			updateType = "session_start"
		case "session_end":
			updateType = "session_end"
		default:
			updateType = "session_update"
		}

		// Build and broadcast the enriched payload
		msg, marshalErr := json.Marshal(fleetUpdate{
			Type:      updateType,
			Session:   session,
			LastEvent: lastEvent,
		})
		if marshalErr != nil {
			slog.Error("marshal fleet update", "err", marshalErr)
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
