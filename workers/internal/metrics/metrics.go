// Package metrics exposes the worker's observability counters.
//
// Kept deliberately dependency-free: no Prometheus client library. The
// counters are plain ``sync/atomic`` uint64s exposed via a small HTTP
// handler (Snapshot + ServeHTTP). Swapping in prometheus/client_golang
// later would not change the call sites. Choosing
// no-dep here avoids adding a library to the worker that isn't needed
// by any other package yet.
//
// The package keeps three counter families: ``dropped_events_total``
// with a ``reason`` label, ``sessions_closed_total`` and
// ``sessions_revived_total``. Every known drop path in the worker
// pipeline increments the first:
//
//   - unmarshal_error       — NATS payload failed json.Unmarshal; the
//                             consumer Terms the message.
//   - orphan_session_end    — session_end for a session_id the server
//                             never saw, once the retry budget has
//                             given its session_start time to land.
//                             ACK'd with a WARN + counter bump and no
//                             event row.
//   - superseded_session_end — session_end published before the
//                             session's current run began (a
//                             re-attachment, or an emitter that sent
//                             its end first) that found the row open.
//                             Recorded as an event; the row's state is
//                             left as it is. On a closed row the same
//                             end counts as closed_session_skip.
//   - closed_session_skip   — event arrived for a session already in
//                             state=closed (a duplicate session_end
//                             included). The
//                             handler skips work; the counter records
//                             how often this happens.
//   - fk_violation          — residual bucket for Postgres FK errors
//                             not covered by orphan_session_end.
//                             Should trend to zero once the orphan
//                             path is fully plumbed.
//   - max_retries_exhausted — consumer hit NATS maxDeliver after
//                             redelivering an event N times.
//
// The counters live in process. Handler renders them in the Prometheus
// text format (a TYPE line per family, then one line per label value)
// so scrapers and humans can read them without a client library;
// NewServer mounts it at /metrics on the workers' metrics listener.
package metrics

import (
	"fmt"
	"net/http"
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

// readHeaderTimeout bounds how long the metrics listener waits for a
// request's headers. A scrape sends a few hundred bytes at once, so
// five seconds is generous for any real client while stopping a slow
// or idle connection from holding a goroutine open indefinitely.
const readHeaderTimeout = 5 * time.Second

// DropReason is a named string for type safety at call sites. Zero
// cost at runtime.
type DropReason string

const (
	ReasonUnmarshalError       DropReason = "unmarshal_error"
	ReasonOrphanSessionEnd     DropReason = "orphan_session_end"
	ReasonSupersededSessionEnd DropReason = "superseded_session_end"
	ReasonClosedSessionSkip    DropReason = "closed_session_skip"
	ReasonFKViolation          DropReason = "fk_violation"
	ReasonMaxRetriesExhausted  DropReason = "max_retries_exhausted"
	ReasonProcessPanic         DropReason = "process_panic"
	// ReasonDuplicateEvent: an event whose client-supplied id is
	// already stored (a re-sent model call, a retried POST, a NATS
	// redelivery of an applied event).
	ReasonDuplicateEvent DropReason = "duplicate_event"
)

// CloseReason mirrors the close_reason values stamped on session_end
// event payloads. Kept in lockstep with the enum documented in
// ARCHITECTURE.md (sessions § close_reason). Worker-side close paths
// — notably the orphan_timeout reaper — bump
// sessions_closed_total{reason=...} so operators can chart the
// non-clean-shutdown rate without trawling per-event payloads.
type CloseReason string

const (
	CloseReasonOrphanTimeout CloseReason = "orphan_timeout"
)

// RevivalTrigger names a worker-side path that transitioned a session
// from stale / lost back to active. The current trigger, child_event,
// covers the parent-bump propagation: a child session's heartbeat /
// post_call / tool_call / etc. propagates freshness to its parent's
// row, and when the parent was stale/lost it's revived to active.
// Operators chart the rate via sessions_revived_total{trigger=...}
// through Handler, which no service mounts yet (README Roadmap).
type RevivalTrigger string

const (
	RevivalTriggerChildEvent RevivalTrigger = "child_event"
)

// droppedEvents is a sharded counter keyed on reason. A global
// sync.RWMutex gates the map's lifetime; individual counters are
// sync/atomic so IncrDropped is lock-free once the entry exists.
var (
	droppedMu     sync.RWMutex
	droppedEvents = map[DropReason]*atomic.Uint64{}

	closedMu       sync.RWMutex
	closedSessions = map[CloseReason]*atomic.Uint64{}

	revivedMu       sync.RWMutex
	revivedSessions = map[RevivalTrigger]*atomic.Uint64{}
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

// ensureCloseCounter mirrors ensureCounter for the closed-sessions
// counter family.
func ensureCloseCounter(reason CloseReason) *atomic.Uint64 {
	closedMu.RLock()
	c, ok := closedSessions[reason]
	closedMu.RUnlock()
	if ok {
		return c
	}
	closedMu.Lock()
	defer closedMu.Unlock()
	if c, ok := closedSessions[reason]; ok {
		return c
	}
	c = &atomic.Uint64{}
	closedSessions[reason] = c
	return c
}

// IncrDropped bumps the counter for the given drop reason. Call sites
// should use the exported DropReason constants above rather than raw
// strings so a new reason surfaces as a compile-time add rather than
// silent drift.
func IncrDropped(reason DropReason) {
	ensureCounter(reason).Add(1)
}

// IncrSessionClosed bumps the closed-session counter for the given
// reason. Used by worker-side close paths (notably the orphan_timeout
// reaper) so operators can chart non-clean-shutdown rate without
// trawling per-event payloads.
func IncrSessionClosed(reason CloseReason) {
	ensureCloseCounter(reason).Add(1)
}

// IncrSessionClosedN bumps the counter by `n`. The reaper closes a
// batch in one SQL pass and reports the count; one atomic Add on a
// single counter beats N atomic Add(1)s in a loop and makes the
// "one bump per session reaped" intent explicit at the call site.
// n=0 is a no-op so callers don't need to guard.
func IncrSessionClosedN(reason CloseReason, n uint64) {
	if n == 0 {
		return
	}
	ensureCloseCounter(reason).Add(n)
}

// ensureRevivedCounter mirrors ensureCounter / ensureCloseCounter for
// the revived-sessions counter family.
func ensureRevivedCounter(trigger RevivalTrigger) *atomic.Uint64 {
	revivedMu.RLock()
	c, ok := revivedSessions[trigger]
	revivedMu.RUnlock()
	if ok {
		return c
	}
	revivedMu.Lock()
	defer revivedMu.Unlock()
	if c, ok := revivedSessions[trigger]; ok {
		return c
	}
	c = &atomic.Uint64{}
	revivedSessions[trigger] = c
	return c
}

// IncrSessionRevived bumps the revived-session counter for the given
// trigger. The child-event propagation path in
// SessionProcessor.bumpParentIfPresent calls this with
// RevivalTriggerChildEvent when a parent transitions stale/lost →
// active because of a child event.
func IncrSessionRevived(trigger RevivalTrigger) {
	ensureRevivedCounter(trigger).Add(1)
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

// SnapshotClosed returns a stable copy of the closed-sessions counters.
func SnapshotClosed() map[CloseReason]uint64 {
	closedMu.RLock()
	defer closedMu.RUnlock()
	out := make(map[CloseReason]uint64, len(closedSessions))
	for reason, c := range closedSessions {
		out[reason] = c.Load()
	}
	return out
}

// SnapshotRevived returns a stable copy of the revived-sessions counters.
func SnapshotRevived() map[RevivalTrigger]uint64 {
	revivedMu.RLock()
	defer revivedMu.RUnlock()
	out := make(map[RevivalTrigger]uint64, len(revivedSessions))
	for trigger, c := range revivedSessions {
		out[trigger] = c.Load()
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

	closedMu.Lock()
	defer closedMu.Unlock()
	closedSessions = map[CloseReason]*atomic.Uint64{}

	revivedMu.Lock()
	defer revivedMu.Unlock()
	revivedSessions = map[RevivalTrigger]*atomic.Uint64{}
}

// NewServer returns the workers' metrics listener: Handler at
// /metrics on addr, and 404 for every other path. The caller starts
// it with ListenAndServe and stops it with Shutdown.
func NewServer(addr string) *http.Server {
	mux := http.NewServeMux()
	mux.Handle("GET /metrics", Handler())
	return &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: readHeaderTimeout,
	}
}

// Handler renders the counters in the Prometheus text format: a TYPE
// line per counter family, then one line per label value in sorted
// order. Hand-written to keep the worker free of the Prometheus client
// dependency.
func Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		// Errors writing to the response body aren't actionable
		// inside a handler -- the connection is either gone or will
		// drop the tail silently. Discard the return values.
		_, _ = fmt.Fprintln(w, "# TYPE dropped_events_total counter")
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
			_, _ = fmt.Fprintf(w, "dropped_events_total{reason=%q} %d\n",
				string(reason), snap[reason])
		}

		_, _ = fmt.Fprintln(w, "# TYPE sessions_closed_total counter")
		closedSnap := SnapshotClosed()
		closeReasons := make([]CloseReason, 0, len(closedSnap))
		for reason := range closedSnap {
			closeReasons = append(closeReasons, reason)
		}
		sort.Slice(closeReasons, func(i, j int) bool {
			return string(closeReasons[i]) < string(closeReasons[j])
		})
		for _, reason := range closeReasons {
			_, _ = fmt.Fprintf(w, "sessions_closed_total{reason=%q} %d\n",
				string(reason), closedSnap[reason])
		}

		_, _ = fmt.Fprintln(w, "# TYPE sessions_revived_total counter")
		revivedSnap := SnapshotRevived()
		triggers := make([]RevivalTrigger, 0, len(revivedSnap))
		for trigger := range revivedSnap {
			triggers = append(triggers, trigger)
		}
		sort.Slice(triggers, func(i, j int) bool {
			return string(triggers[i]) < string(triggers[j])
		})
		for _, trigger := range triggers {
			_, _ = fmt.Fprintf(w, "sessions_revived_total{trigger=%q} %d\n",
				string(trigger), revivedSnap[trigger])
		}
	})
}
