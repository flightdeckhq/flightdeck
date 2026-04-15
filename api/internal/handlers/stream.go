package handlers

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/flightdeckhq/flightdeck/api/internal/auth"
	"github.com/flightdeckhq/flightdeck/api/internal/ws"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(_ *http.Request) bool { return true },
}

// StreamHandler handles WS /v1/stream.
//
// The WebSocket upgrade handshake cannot carry an Authorization
// header from the browser (the standard WebSocket API does not
// expose a way to set request headers), so this handler additionally
// accepts the bearer token as a ?token= query parameter. When a
// validator is provided, both sources are checked -- Authorization
// header first, then query string -- and the connection is rejected
// with 401 before upgrade if neither resolves to a valid token.
// Passing validator=nil skips auth entirely and is only used by
// NewForTesting. See DECISIONS.md D095.
//
// @Summary      Real-time fleet stream
// @Description  WebSocket connection for real-time fleet state updates. Upgrades HTTP to WebSocket. Accepts bearer token via the Authorization header OR ``?token=`` query parameter (browsers cannot set headers on the WS upgrade).
// @Tags         stream
// @Param        token  query  string  false  "Bearer token, alternative to Authorization header"
// @Success      101  {string}  string
// @Failure      401  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/stream [get]
func StreamHandler(hub *ws.Hub, validator *auth.Validator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if validator != nil {
			raw := extractStreamToken(r)
			if raw == "" {
				http.Error(w, `{"error":"missing bearer token"}`, http.StatusUnauthorized)
				return
			}
			result, err := validator.Validate(r.Context(), raw)
			if err != nil {
				slog.Error("stream auth error", "err", err)
				http.Error(w, `{"error":"auth lookup error"}`, http.StatusInternalServerError)
				return
			}
			if !result.Valid {
				reason := result.Reason
				if reason == "" {
					reason = "invalid token"
				}
				http.Error(w, `{"error":"`+reason+`"}`, http.StatusUnauthorized)
				return
			}
		}

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

// extractStreamToken reads the bearer token from either the standard
// Authorization header or the ?token= query parameter. Returns the
// empty string when neither source provides a non-empty token.
func extractStreamToken(r *http.Request) string {
	if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
		return strings.TrimPrefix(h, "Bearer ")
	}
	return r.URL.Query().Get("token")
}
