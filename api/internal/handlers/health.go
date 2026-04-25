// Package handlers provides HTTP request handlers for the query API.
package handlers

import (
	"encoding/json"
	"net/http"
)

// MaxRequestBodyBytes bounds JSON POST/PUT bodies on the query API
// at 256 KiB. The ingestion API has its own 1 MiB bound for sensor
// event batches; the query API is for human-issued admin actions
// (creating policies, directives, tokens, custom directives) where
// 256 KiB is generously above any real payload. Phase 4.5 M-21:
// previously these handlers used unbounded ``json.NewDecoder(r.Body)``
// which would happily allocate as much memory as a slow-loris client
// could send in a single request.
const MaxRequestBodyBytes = 256 * 1024

// limitBody wraps r.Body in [http.MaxBytesReader] so subsequent
// reads (json.Decode, io.ReadAll) error out with
// http.MaxBytesError once the bound is exceeded. Callers should
// translate that error to 413 Payload Too Large.
func limitBody(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, MaxRequestBodyBytes)
}

// ErrorResponse is the standard error response body.
type ErrorResponse struct {
	Error string `json:"error"`
}

// HealthHandler returns a simple liveness check.
//
// @Summary      Health check
// @Description  Returns service health status
// @Tags         health
// @Produce      json
// @Success      200  {object}  map[string]string
// @Router       /health [get]
func HealthHandler() http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"status":  "ok",
			"service": "api",
		})
	}
}

func writeError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
