package handlers

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// CreateAccessTokenRequest is the request body for POST /v1/access-tokens.
type CreateAccessTokenRequest struct {
	Name string `json:"name"`
}

// RenameAccessTokenRequest is the request body for PATCH /v1/access-tokens/{id}.
type RenameAccessTokenRequest struct {
	Name string `json:"name"`
}

// AccessTokensListHandler handles GET /v1/access-tokens.
//
// @Summary      List access tokens
// @Description  Returns every access_tokens row. Hash and salt are never exposed; the raw token itself is available only on the POST response at creation time (D095).
// @Tags         access-tokens
// @Produce      json
// @Success      200  {array}   store.AccessTokenRow
// @Failure      401  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/access-tokens [get]
func AccessTokensListHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		rows, err := s.ListAccessTokens(r.Context())
		if err != nil {
			slog.Error("list tokens error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(rows)
	}
}

// AccessTokenCreateHandler handles POST /v1/access-tokens.
//
// @Summary      Create an access token
// @Description  Mints an opaque ftd_ bearer token. The plaintext token is returned exactly once in the response; the platform cannot recover it afterwards. See DECISIONS.md D095.
// @Tags         access-tokens
// @Accept       json
// @Produce      json
// @Param        token  body      CreateAccessTokenRequest  true  "Token name"
// @Success      201  {object}  store.CreatedAccessTokenResponse
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/access-tokens [post]
func AccessTokenCreateHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		limitBody(w, r)
		var req CreateAccessTokenRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if strings.TrimSpace(req.Name) == "" {
			writeError(w, http.StatusBadRequest, "name is required")
			return
		}
		created, err := s.CreateAccessToken(r.Context(), req.Name)
		if err != nil {
			if errors.Is(err, store.ErrAccessTokenNameRequired) {
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

// AccessTokenDeleteHandler handles DELETE /v1/access-tokens/{id}.
//
// @Summary      Revoke an access token
// @Description  Deletes the access_tokens row. The seeded Development Token row is protected and returns 403. Sessions previously authenticated with the token keep their token_name for auditability (sessions.token_id is set to NULL via ON DELETE SET NULL). See DECISIONS.md D095.
// @Tags         access-tokens
// @Param        id  path  string  true  "Token ID"
// @Success      204
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/access-tokens/{id} [delete]
func AccessTokenDeleteHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			writeError(w, http.StatusBadRequest, "token id is required")
			return
		}
		err := s.DeleteAccessToken(r.Context(), id)
		switch {
		case errors.Is(err, store.ErrDevAccessTokenProtected):
			writeError(w, http.StatusForbidden, "the Development Token row cannot be deleted. Set ENVIRONMENT!=dev to disable it globally.")
			return
		case errors.Is(err, store.ErrAccessTokenNotFound):
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

// AccessTokenRenameHandler handles PATCH /v1/access-tokens/{id}.
//
// @Summary      Rename an access token
// @Description  Updates the name field on the access_tokens row. Historical sessions keep their original token_name snapshot. The Development Token row is protected and returns 403.
// @Tags         access-tokens
// @Accept       json
// @Produce      json
// @Param        id     path  string              true  "Token ID"
// @Param        token  body  RenameAccessTokenRequest  true  "New name"
// @Success      200  {object}  store.AccessTokenRow
// @Failure      400  {object}  ErrorResponse
// @Failure      401  {object}  ErrorResponse
// @Failure      403  {object}  ErrorResponse
// @Failure      404  {object}  ErrorResponse
// @Failure      500  {object}  ErrorResponse
// @Router       /v1/access-tokens/{id} [patch]
func AccessTokenRenameHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("id")
		if id == "" {
			writeError(w, http.StatusBadRequest, "token id is required")
			return
		}
		limitBody(w, r)
		var req RenameAccessTokenRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid JSON")
			return
		}
		if strings.TrimSpace(req.Name) == "" {
			writeError(w, http.StatusBadRequest, "name is required")
			return
		}
		row, err := s.RenameAccessToken(r.Context(), id, req.Name)
		switch {
		case errors.Is(err, store.ErrDevAccessTokenProtected):
			writeError(w, http.StatusForbidden, "the Development Token row cannot be renamed. Set ENVIRONMENT!=dev to disable it globally.")
			return
		case errors.Is(err, store.ErrAccessTokenNotFound):
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
