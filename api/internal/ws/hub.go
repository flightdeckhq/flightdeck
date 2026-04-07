// Package ws provides a WebSocket hub that broadcasts Postgres NOTIFY
// events to all connected dashboard clients.
package ws

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

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
}

// NewHub creates a Hub.
func NewHub() *Hub {
	return &Hub{
		clients:    make(map[*Client]struct{}),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		broadcast:  make(chan []byte, broadcastChannelBuffer),
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
			h.mu.RLock()
			for client := range h.clients {
				select {
				case client.send <- msg:
				default:
					// Client buffer full -- drop and unregister
					go func(c *Client) {
						select {
						case h.unregister <- c:
						default:
							// Channel full, client will be cleaned up on next broadcast
						}
					}(client)
				}
			}
			h.mu.RUnlock()
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

// TODO(KI08)[Phase 3]: Every NOTIFY broadcasts to all
// connected dashboard clients regardless of what they
// are viewing. At 500 users × 10k events/min this is
// 5M messages/min.
// Fix: clients subscribe to specific flavors. Only
// broadcast relevant updates per client.
// See DECISIONS.md D044.

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
		h.Broadcast([]byte(notification.Payload))
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
