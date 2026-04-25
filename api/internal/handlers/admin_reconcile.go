package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// reconcileLock serialises concurrent calls to the reconcile
// endpoint. Two parallel reconciles on the same DB would race each
// other's per-agent UPDATEs — fine in theory (last-writer-wins on the
// same computed ground truth) but operators expect a deterministic
// single-run cost and response shape. A process-level ``TryLock``
// returns 409 Conflict when the endpoint is busy; a distributed
// (multi-API-replica) deployment that cares about cross-process
// mutual exclusion should layer a Postgres advisory lock on top in a
// future revision.
var reconcileLock sync.Mutex

// AdminReconcileAgentsHandler makes the agents table correct in one
// call. It (1) recomputes every agent's denormalised rollup counters
// from sessions ground truth, then (2) deletes orphan rows whose
// post-reconcile total_sessions is 0 AND whose last_seen_at is older
// than ``orphan_threshold_secs`` (default 30 days). Admin-only —
// gated via ``auth.AdminRequired`` in server.go.
//
// @Summary      Reconcile agent rollup counters AND reap stale orphan rows
// @Description  One-shot operation that makes the agents table correct: recomputes total_sessions, total_tokens, first_seen_at, and last_seen_at against sessions ground truth (per-agent transaction; partial errors surface in the response errors array), then deletes orphan rows whose post-reconcile total_sessions = 0 AND last_seen_at < NOW() - orphan_threshold_secs. Pass orphan_threshold_secs=0 to skip the delete step (counters-only). Default threshold is 30 days. Values < 60 s rejected with 400 to prevent reaping freshly-upserted agents that the worker has not yet wired up to a session_start.
// @Tags         admin
// @Produce      json
// @Param        orphan_threshold_secs  query  int  false  "Override the 30d default for the orphan-delete step. 0 skips deletion (counters-only). Values 1..59 rejected with 400."
// @Success      200  {object}  store.ReconcileResult  "Reconcile completed; errors array is empty"
// @Failure      207  {object}  store.ReconcileResult  "Reconcile completed with per-agent errors (see errors array)"
// @Failure      400  {object}  ErrorResponse          "orphan_threshold_secs malformed or absurdly small"
// @Failure      401  {object}  ErrorResponse          "Missing or invalid bearer token"
// @Failure      403  {object}  ErrorResponse          "Token is valid but lacks admin scope"
// @Failure      409  {object}  ErrorResponse          "Another reconcile is already in progress"
// @Failure      500  {object}  ErrorResponse          "Fatal database error (agent listing or pool exhaustion)"
// @Router       /v1/admin/reconcile-agents [post]
func AdminReconcileAgentsHandler(s store.Querier) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !reconcileLock.TryLock() {
			writeError(w, http.StatusConflict, "a reconcile is already in progress")
			return
		}
		defer reconcileLock.Unlock()

		threshold := store.DefaultOrphanDeleteThreshold
		if raw := r.URL.Query().Get("orphan_threshold_secs"); raw != "" {
			n, perr := strconv.ParseInt(raw, 10, 64)
			if perr != nil {
				writeError(w, http.StatusBadRequest, "orphan_threshold_secs must be an integer")
				return
			}
			if n <= 0 {
				// Operator explicitly opted out of the orphan-delete
				// step. Pass 0 down so the store skips it.
				threshold = 0
			} else {
				if n < 60 {
					writeError(w, http.StatusBadRequest, "orphan_threshold_secs must be 0 (skip) or >= 60")
					return
				}
				threshold = time.Duration(n) * time.Second
			}
		}

		result, err := s.ReconcileAgents(r.Context(), threshold)
		if err != nil {
			slog.Error("reconcile agents fatal", "err", err)
			writeError(w, http.StatusInternalServerError, "internal server error")
			return
		}

		// 207 Multi-Status signals "completed with partial errors" —
		// the response body IS the normal ReconcileResult shape, with
		// the errors array non-empty. Matches the contract documented
		// in the V5.b test catalog.
		status := http.StatusOK
		if len(result.Errors) > 0 {
			status = http.StatusMultiStatus
			slog.Warn("reconcile agents partial success",
				"errors", len(result.Errors),
				"agents_scanned", result.AgentsScanned,
				"agents_updated", result.AgentsUpdated,
				"agents_deleted", result.AgentsDeleted,
				"delete_threshold", result.DeleteThreshold,
			)
		} else {
			slog.Info("reconcile agents ok",
				"agents_scanned", result.AgentsScanned,
				"agents_updated", result.AgentsUpdated,
				"agents_deleted", result.AgentsDeleted,
				"delete_threshold", result.DeleteThreshold,
				"duration_ms", result.DurationMs,
			)
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(result)
	}
}
