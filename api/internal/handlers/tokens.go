package handlers

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// CreateTokenRequest is the request body for POST /v1/tokens.
type CreateTokenRequest struct {
	Name string `json:"name"`
}

// RenameTokenRequest is the request body for PATCH /v1/tokens/{id}.
type RenameTokenRequest struct {
	Name string `json:"name"`
}

// TokensListHandler handles GET /v1/tokens.
//
// @Summary      List API tokens
// @Description  Returns every api_tokens row. Hash and salt are never exposed; the raw token itself is available only on the POST response at creation time (D095).
// @Tags         tokens
// @Produce      json
// @Success      200  {array}   store.TokenRow
// @Failure      401  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/tokens [get]
func TokensListHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := s.ListTokens(r.Context())
		if err != nil {
			slog.Error("list tokens error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(rows)
	}
}

// TokenCreateHandler handles POST /v1/tokens.
//
// @Summary      Create an API token
// @Description  Mints an opaque ftd_ bearer token. The plaintext token is returned exactly once in the response; the platform cannot recover it afterwards. See DECISIONS.md D095.
// @Tags         tokens
// @Accept       json
// @Produce      json
// @Param        token  body      CreateTokenRequest  true  "Token name"
// @Success      201  {object}  store.CreatedTokenResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/tokens [post]
func TokenCreateHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req CreateTokenRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if strings.TrimSpace(req.Name) == "" {
			writeError(w, http.StatusBadRequest, "name is required")
			return
		}
		created, err := s.CreateToken(r.Context(), req.Name)
		if err != nil {
			if errors.Is(err, store.ErrTokenNameRequired) {
				writeError(w, http.StatusBadRequest, "name is required")
				return
			}
			slog.Error("create token error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(created)
	}
}

// TokenDeleteHandler handles DELETE /v1/tokens/{id}.
//
// @Summary      Revoke an API token
// @Description  Deletes the api_tokens row. The seeded Development Token row is protected and returns 403. Sessions previously authenticated with the token keep their token_name for auditability (sessions.token_id is set to NULL via ON DELETE SET NULL). See DECISIONS.md D095.
// @Tags         tokens
// @Param        id  path  string  true  "Token ID"
// @Success      204
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/tokens/{id} [delete]
func TokenDeleteHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			writeError(w, http.StatusBadRequest, "token id is required")
			return
		}
		err := s.DeleteToken(r.Context(), id)
		switch {
		case errors.Is(err, store.ErrDevTokenProtected):
			writeError(w, http.StatusForbidden, "the Development Token row cannot be deleted. Set ENVIRONMENT!=dev to disable it globally.")
			return
		case errors.Is(err, store.ErrTokenNotFound):
			writeError(w, http.StatusNotFound, "token not found")
			return
		case err != nil:
			slog.Error("delete token error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// TokenRenameHandler handles PATCH /v1/tokens/{id}.
//
// @Summary      Rename an API token
// @Description  Updates the name field on the api_tokens row. Historical sessions keep their original token_name snapshot. The Development Token row is protected and returns 403.
// @Tags         tokens
// @Accept       json
// @Produce      json
// @Param        id     path  string              true  "Token ID"
// @Param        token  body  RenameTokenRequest  true  "New name"
// @Success      200  {object}  store.TokenRow
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/tokens/{id} [patch]
func TokenRenameHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			writeError(w, http.StatusBadRequest, "token id is required")
			return
		}
		var req RenameTokenRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if strings.TrimSpace(req.Name) == "" {
			writeError(w, http.StatusBadRequest, "name is required")
			return
		}
		row, err := s.RenameToken(r.Context(), id, req.Name)
		switch {
		case errors.Is(err, store.ErrDevTokenProtected):
			writeError(w, http.StatusForbidden, "the Development Token row cannot be renamed. Set ENVIRONMENT!=dev to disable it globally.")
			return
		case errors.Is(err, store.ErrTokenNotFound):
			writeError(w, http.StatusNotFound, "token not found")
			return
		case err != nil:
			slog.Error("rename token error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(row)
	}
}
