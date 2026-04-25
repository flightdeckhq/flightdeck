// Package metrics exposes the worker's Phase 4 observability counters.
//
// Kept deliberately dependency-free: no Prometheus client library. The
// counters are plain ``sync/atomic`` uint64s exposed via a small HTTP
// handler (Snapshot + ServeHTTP). A future phase can swap in
// prometheus/client_golang without changing the call sites. Choosing
// no-dep here avoids adding a library to the worker that isn't needed
// by any other package yet.
//
// The single counter shipped in Phase 4 is ``dropped_events_total``
// with a ``reason`` label. Every known drop path in the worker
// pipeline increments it:
//
//   - unmarshal_error       — NATS payload failed json.Unmarshal; the
//                             consumer Terms the message.
//   - orphan_session_end    — session_end arrived for an unknown
//                             session_id. Previously Nak'd with an
//                             opaque FK-violation; now ACK'd with a
//                             structured WARN + counter bump.
//   - closed_session_skip   — non-session_end event arrived for a
//                             session already in state=closed. The
//                             handler skips work; the counter records
//                             how often this happens.
//   - fk_violation          — residual bucket for Postgres FK errors
//                             not covered by orphan_session_end.
//                             Should trend to zero once the orphan
//                             path is fully plumbed.
//   - max_retries_exhausted — consumer hit NATS maxDeliver after
//                             redelivering an event N times.
//
// Operators observe the counter via ``GET /metrics`` on the worker's
// management port. Format is a trivial text line-per-counter so scrapers
// (and humans) can parse it without a client library.
package metrics

import (
	"fmt"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
)

// DropReason is a named string for type safety at call sites. Zero
// cost at runtime.
type DropReason string

const (
	ReasonUnmarshalError     DropReason = "unmarshal_error"
	ReasonOrphanSessionEnd   DropReason = "orphan_session_end"
	ReasonClosedSessionSkip  DropReason = "closed_session_skip"
	ReasonFKViolation        DropReason = "fk_violation"
	ReasonMaxRetriesExhausted DropReason = "max_retries_exhausted"
)

// droppedEvents is a sharded counter keyed on reason. A global
// sync.RWMutex gates the map's lifetime; individual counters are
// sync/atomic so IncrDropped is lock-free once the entry exists.
var (
	droppedMu     sync.RWMutex
	droppedEvents = map[DropReason]*atomic.Uint64{}
)

// ensureCounter returns a live counter for the given reason, creating
// it on first access. O(1) after the first call per reason.
func ensureCounter(reason DropReason) *atomic.Uint64 {
	droppedMu.RLock()
	c, ok := droppedEvents[reason]
	droppedMu.RUnlock()
	if ok {
		return c
	}
	droppedMu.Lock()
	defer droppedMu.Unlock()
	if c, ok := droppedEvents[reason]; ok {
		return c
	}
	c = &atomic.Uint64{}
	droppedEvents[reason] = c
	return c
}

// IncrDropped bumps the counter for the given drop reason. Call sites
// should use the exported DropReason constants above rather than raw
// strings so a new reason surfaces as a compile-time add rather than
// silent drift.
func IncrDropped(reason DropReason) {
	ensureCounter(reason).Add(1)
}

// Snapshot returns a stable copy of the dropped-events counters,
// sorted by reason for deterministic output. Used by tests and the
// /metrics handler.
func Snapshot() map[DropReason]uint64 {
	droppedMu.RLock()
	defer droppedMu.RUnlock()
	out := make(map[DropReason]uint64, len(droppedEvents))
	for reason, c := range droppedEvents {
		out[reason] = c.Load()
	}
	return out
}

// Reset clears every counter. Test-only; production code never calls
// this because monotonic counters must not go backwards in a running
// worker.
func Reset() {
	droppedMu.Lock()
	defer droppedMu.Unlock()
	droppedEvents = map[DropReason]*atomic.Uint64{}
}

// Handler serves the /metrics endpoint. Trivial text format, one line
// per (counter, reason) pair, to keep the worker free of the
// prometheus client dependency until a future phase needs it.
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		snap := Snapshot()
		// Deterministic ordering so the output is scrape-friendly.
		reasons := make([]DropReason, 0, len(snap))
		for reason := range snap {
			reasons = append(reasons, reason)
		}
		sort.Slice(reasons, func(i, j int) bool {
			return string(reasons[i]) < string(reasons[j])
		})
		for _, reason := range reasons {
			// Errors writing to the response body aren't actionable
			// inside a handler -- the connection is either gone or
			// will drop the tail silently. Discard the return value.
			_, _ = fmt.Fprintf(w, "dropped_events_total{reason=%q} %d\n",
				string(reason), snap[reason])
		}
	})
}
