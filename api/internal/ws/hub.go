// Package ws provides a WebSocket hub that broadcasts Postgres NOTIFY
// events to all connected dashboard clients.
package ws

import (
	"context"
	"log/slog"
	"sync"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"
)

const notifyChannel = "flightdeck_fleet"

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

// ListenNotify subscribes to the Postgres NOTIFY channel and broadcasts
// each notification payload to all connected WebSocket clients.
func (h *Hub) ListenNotify(ctx context.Context, pool *pgxpool.Pool) {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		slog.Error("acquire conn for LISTEN", "err", err)
		return
	}
	defer conn.Release()

	_, err = conn.Exec(ctx, "LISTEN "+notifyChannel)
	if err != nil {
		slog.Error("LISTEN failed", "channel", notifyChannel, "err", err)
		return
	}

	slog.Info("listening on Postgres NOTIFY", "channel", notifyChannel)

	for {
		notification, err := conn.Conn().WaitForNotification(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return // Context cancelled -- clean shutdown
			}
			slog.Error("wait for notification", "err", err)
			return
		}

		h.Broadcast([]byte(notification.Payload))
	}
}
