package handlers

import (
	"log/slog"
	"net/http"

	"github.com/flightdeckhq/flightdeck/api/internal/ws"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(_ *http.Request) bool { return true },
}

// StreamHandler handles WS /v1/stream.
// Upgrades the connection and registers with the Hub for real-time updates.
func StreamHandler(hub *ws.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			slog.Error("websocket upgrade error", "err", err)
			return
		}

		client := hub.Register(conn)
		go ws.WritePump(client)

		// Read pump: wait for close or error
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				hub.Unregister(client)
				break
			}
		}
	}
}
