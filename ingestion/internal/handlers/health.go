// Package handlers provides HTTP request handlers for the ingestion API.
package handlers

import (
	"encoding/json"
	"net/http"
)

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
			"service": "ingestion",
		})
	}
}
