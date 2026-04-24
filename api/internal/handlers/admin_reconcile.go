package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"

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

// AdminReconcileAgentsHandler recomputes every agent's rollup counters
// from sessions ground truth. Admin-only — gated via
// ``auth.AdminRequired`` in server.go.
//
// @Summary      Reconcile agent rollup counters against sessions ground truth
// @Description  Scans every agents row and recomputes total_sessions, total_tokens, first_seen_at, and last_seen_at by querying the sessions table. Per-agent transaction; continues on per-agent error and surfaces the failures in the response body's errors array. Orphan agents (zero actual sessions) have their counters zeroed but first_seen_at and last_seen_at are preserved — agent-row cleanup is out of scope for this endpoint. Concurrent calls return 409; a 207 indicates partial success (some per-agent errors). Intended for operator use when drift is suspected, not as a scheduled job.
// @Tags         admin
// @Produce      json
// @Success      200  {object}  store.ReconcileResult  "Reconcile completed; errors array is empty"
// @Failure      207  {object}  store.ReconcileResult  "Reconcile completed with per-agent errors (see errors array)"
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

		result, err := s.ReconcileAgents(r.Context())
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
			)
		} else {
			slog.Info("reconcile agents ok",
				"agents_scanned", result.AgentsScanned,
				"agents_updated", result.AgentsUpdated,
				"duration_ms", result.DurationMs,
			)
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(result)
	}
}
