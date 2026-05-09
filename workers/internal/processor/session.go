// Package processor contains event processing logic for the worker pipeline.
package processor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const reconcilerInterval = 60 * time.Second

// identityFromEvent extracts the D115 agent identity fields from an
// event payload. The ingestion API has already validated them (UUID
// shape, vocabulary), so the worker trusts the values verbatim.
func identityFromEvent(e consumer.EventPayload) writer.AgentIdentity {
	return writer.AgentIdentity{
		AgentID:    e.AgentID,
		AgentType:  e.AgentType,
		ClientType: e.ClientType,
		AgentName:  e.AgentName,
		UserName:   e.User,
		Hostname:   e.Hostname,
	}
}

// SessionProcessor manages the session state machine in Postgres.
type SessionProcessor struct {
	w    *writer.Writer
	pool *pgxpool.Pool
}

// NewSessionProcessor creates a SessionProcessor.
func NewSessionProcessor(w *writer.Writer, pool *pgxpool.Pool) *SessionProcessor {
	return &SessionProcessor{w: w, pool: pool}
}

// handleSessionGuard enforces the revive-or-create-or-skip policy
// before a non-session_start handler applies its side effects.
//
//   - closed -> warn + skip (caller returns nil). The user explicitly
//     ended the session; reviving would contradict an explicit exit.
//   - stale/lost -> warn + revive to active + advance last_seen_at
//     (D105). Caller proceeds with normal processing.
//   - not-found (pgx.ErrNoRows) -> D106 lazy-create a new row from
//     the event's best-effort identity fields, then caller proceeds.
//     Without this the caller's UPDATE queries no-op silently and
//     the subsequent InsertEvent FK-violates, so the event is
//     dropped even though the session is legitimately active.
//   - active / idle / unknown-DB-error -> no-op, caller proceeds.
//
// Returns true if the caller should skip further processing (closed
// sessions only). All other states / failure modes fall open so the
// event's downstream UPDATE + InsertEvent have a chance to succeed.
//
// HandleSessionEnd uses isClosed instead -- closing a stale/lost
// session should transition directly via CloseSession, and D106 does
// not lazy-create on session_end (a teardown signal for a session we
// never saw should not retroactively manifest a closed row).
func (sp *SessionProcessor) handleSessionGuard(ctx context.Context, e consumer.EventPayload) (skip bool) {
	var state string
	err := sp.pool.QueryRow(ctx,
		"SELECT state FROM sessions WHERE session_id = $1::uuid", e.SessionID,
	).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		// D106: session never seen. Lazy-create from event fields.
		occurredAt, tsErr := time.Parse(time.RFC3339, e.Timestamp)
		if tsErr != nil {
			occurredAt = time.Now().UTC()
		}
		created, cErr := sp.w.ReviveOrCreateSession(
			ctx, e.SessionID, e.Flavor, e.AgentType,
			e.Host, e.Framework, e.Model,
			identityFromEvent(e), occurredAt,
			e.ParentSessionID, e.AgentRole,
		)
		if cErr != nil {
			// Lazy-create failed. Log and fail open -- InsertEvent
			// will then FK-violate and the consumer will Nak+retry,
			// which is the pre-D106 behaviour for this failure mode.
			slog.Error("lazy-create session failed (D106)",
				"session_id", e.SessionID,
				"event_type", e.EventType,
				"err", cErr,
			)
			return false
		}
		if created {
			slog.Info("lazy-created session on event (D106)",
				"session_id", e.SessionID,
				"event_type", e.EventType,
				"flavor", e.Flavor,
			)
		}
		sp.upgradeContextIfPresent(ctx, e)
		return false
	}
	if err != nil {
		// Non-ErrNoRows DB error -- fail open. Matches the prior
		// handleTerminalGuard posture. Skip the context upgrade: we
		// have no confirmation the row exists, so the UPDATE would
		// no-op silently, and a transient DB blip should not trigger
		// extra write pressure.
		return false
	}
	// Row exists. If the event payload carries sub-agent linkage
	// and the row's parent_session_id / agent_role columns are still
	// NULL (lazy-create that ran before linkage was visible, or a
	// session whose framework / plugin failed to emit session_start
	// but keeps emitting interior events), backfill idempotently.
	// No-op when the row already has linkage.
	if e.ParentSessionID != "" || e.AgentRole != "" {
		if bErr := sp.w.BackfillSubAgentLinkage(
			ctx, e.SessionID, e.ParentSessionID, e.AgentRole,
		); bErr != nil {
			slog.Warn("sub-agent linkage backfill failed",
				"session_id", e.SessionID,
				"err", bErr,
			)
		}
	}
	switch state {
	case "closed":
		metrics.IncrDropped(metrics.ReasonClosedSessionSkip)
		slog.Warn("skipping event for closed session",
			"session_id", e.SessionID,
			"event_type", e.EventType,
		)
		return true
	case "stale", "lost":
		slog.Warn("reviving stale/lost session on event (D105)",
			"session_id", e.SessionID,
			"event_type", e.EventType,
			"prior_state", state,
		)
		if _, rerr := sp.w.ReviveIfRevivable(ctx, e.SessionID); rerr != nil {
			// Revival failure is non-fatal: log and let the event's
			// normal side effects run. UpdateLastSeen / UpdateTokensUsed
			// still execute the same UPDATE against state-agnostic
			// WHERE clauses, so last_seen_at advances even if the
			// state flip missed. The worst case is the reconciler
			// re-observes state=stale|lost with a fresh last_seen_at
			// on its next tick and leaves it alone.
			slog.Error("revive session failed",
				"session_id", e.SessionID,
				"event_type", e.EventType,
				"err", rerr,
			)
		}
		sp.upgradeContextIfPresent(ctx, e)
		return false
	default:
		sp.upgradeContextIfPresent(ctx, e)
		return false
	}
}

// upgradeContextIfPresent fills in sessions.context when the incoming
// event carries one. Called from every non-closed branch of
// handleSessionGuard so lazy-created rows (D106) and already-active
// rows whose session_start never landed both pick up context from the
// first event that actually reaches the worker.
//
// Scoped to the context column only. Flavor, agent_type, token_id,
// and token_name remain session_start-only writes to preserve D094
// attribution semantics: a non-session_start event has no authoritative
// source for those columns.
//
// The UPDATE uses COALESCE(NULLIF(context, '{}'::jsonb), EXCLUDED) so
// real stored context is not overwritten -- safe to call repeatedly,
// safe on the session revival path where the context genuinely changed
// since the previous run (default: keep-old / write-once; revisit if
// users report stale working_dir after cross-run directory changes).
func (sp *SessionProcessor) upgradeContextIfPresent(ctx context.Context, e consumer.EventPayload) {
	if len(e.Context) == 0 {
		return
	}
	cbytes, merr := json.Marshal(e.Context)
	if merr != nil {
		slog.Warn("marshal event context for upgrade",
			"session_id", e.SessionID,
			"event_type", e.EventType,
			"err", merr,
		)
		return
	}
	if uerr := sp.w.UpgradeSessionContext(ctx, e.SessionID, cbytes); uerr != nil {
		slog.Warn("upgrade session context failed",
			"session_id", e.SessionID,
			"event_type", e.EventType,
			"err", uerr,
		)
	}
}

// sessionLookup is the result of sessionLookupState. "missing" distinguishes
// "unknown session_id" from "known but closed" so HandleSessionEnd can emit
// a WARN + dropped-events counter increment for the former while treating
// the latter as an idempotent no-op. Phase 4 D2: orphan session_end was
// previously dropped via a silent FK-violation + NATS Nak loop; this
// three-way result surfaces it cleanly.
type sessionLookup int

const (
	sessionLookupMissing sessionLookup = iota
	sessionLookupClosed
	sessionLookupOpen
)

// sessionLookupState reports whether the session row is missing, present
// and closed, or present and non-closed. Fails open on a DB error (returns
// Missing) so the close path still runs -- matching the pre-Phase-4
// isClosed-returns-false fallback.
func (sp *SessionProcessor) sessionLookupState(ctx context.Context, sessionID string) sessionLookup {
	var state string
	err := sp.pool.QueryRow(ctx,
		"SELECT state FROM sessions WHERE session_id = $1::uuid", sessionID,
	).Scan(&state)
	if err != nil {
		// pgx surfaces "no rows" as pgx.ErrNoRows; any other error
		// (network, malformed UUID cast, etc.) also funnels here.
		// Matching substring on error text keeps the import surface
		// small -- pgx.ErrNoRows is the only sentinel we care about
		// distinguishing, and the rest collapse to "assume missing,
		// let the caller decide".
		if strings.Contains(err.Error(), "no rows in result set") {
			return sessionLookupMissing
		}
		return sessionLookupMissing
	}
	if state == "closed" {
		return sessionLookupClosed
	}
	return sessionLookupOpen
}

// HandleSessionStart upserts the agent and creates (or revives) a session.
//
// D094: session_start events are the attach path. The ingestion API
// has already revived the row synchronously (flipping state back to
// active and recording a session_attachments row) so by the time this
// runs the row is state=active and UpsertSession's ON CONFLICT branch
// only has to refresh last_seen_at and the optional identity fields.
// Skipping session_start here (the old KI13 behaviour) would undo the
// attachment because the response envelope has already been sent to
// the sensor.
//
// D105 generalised the terminal policy: heartbeat, post_call, tool_call,
// pre_call, and directive_result now run through handleSessionGuard,
// which revives stale/lost sessions on the fly, skips only closed ones,
// and (since D106) lazily creates the row when it doesn't exist.
// session_end uses isClosed (a closed session's session_end is a
// no-op; a stale or lost session_end goes straight to closed via
// CloseSession rather than flickering through active). D106's
// lazy-create path deliberately excludes session_end -- a teardown
// signal for a session we never saw should not retroactively manifest
// a closed row.
//
// The runtime context dict from e.Context is marshaled to JSON and
// passed to UpsertSession, which writes it once into sessions.context
// (JSONB) on insert. The ON CONFLICT branch deliberately does NOT
// touch context so reconnects from the same session_id can't
// overwrite the initial collection.
func (sp *SessionProcessor) HandleSessionStart(ctx context.Context, e consumer.EventPayload) error {
	identity := identityFromEvent(e)
	if err := sp.w.UpsertAgent(ctx, identity); err != nil {
		return fmt.Errorf("session start: %w", err)
	}
	var contextJSON []byte
	if len(e.Context) > 0 {
		marshaled, mErr := json.Marshal(e.Context)
		if mErr != nil {
			slog.Warn("marshal session context",
				"session_id", e.SessionID,
				"err", mErr,
			)
		} else {
			contextJSON = marshaled
		}
	}

	// D126 § 3 forward-reference soft-link. When this event is a
	// sub-agent session_start whose parent_session_id is not yet in
	// the DB, INSERT a parent-stub row first so the child's UpsertSession
	// satisfies the new parent_session_id FK. The real parent's later
	// session_start (if it ever arrives) upgrades the stub via
	// UpsertSession's existing write-once-but-upgrade-from-"unknown"
	// branch. Stub creation failure is logged-but-non-fatal: the child
	// INSERT will then FK-violate, the worker NAKs, NATS redelivers,
	// and the stub path retries on the redelivery — better than
	// failing the wider session_start path on a transient stub-INSERT
	// hiccup. ParentSessionID is empty on root sessions and direct-SDK
	// sessions, so the guard short-circuits for the overwhelming
	// majority of session_start events.
	if e.ParentSessionID != "" {
		exists, lErr := sp.w.SessionExists(ctx, e.ParentSessionID)
		if lErr != nil {
			slog.Warn("parent session lookup failed",
				"session_id", e.SessionID,
				"parent_session_id", e.ParentSessionID,
				"err", lErr,
			)
		} else if !exists {
			startedAt, tErr := time.Parse(time.RFC3339, e.Timestamp)
			if tErr != nil {
				startedAt = time.Now().UTC()
			}
			if _, sErr := sp.w.UpsertParentStub(
				ctx, e.ParentSessionID, startedAt,
			); sErr != nil {
				slog.Warn("upsert parent stub failed",
					"session_id", e.SessionID,
					"parent_session_id", e.ParentSessionID,
					"err", sErr,
				)
			}
		}
	}

	created, err := sp.w.UpsertSession(
		ctx, e.SessionID, e.Flavor, e.AgentType,
		e.Host, e.Framework, e.Model, "active",
		e.AgentID, e.ClientType, e.AgentName,
		contextJSON,
		e.TokenID, e.TokenName,
		e.ParentSessionID, e.AgentRole,
	)
	if err != nil {
		return fmt.Errorf("session start: %w", err)
	}
	if created {
		if bErr := sp.w.BumpAgentSessionCount(ctx, e.AgentID); bErr != nil {
			// Non-fatal -- see ReviveOrCreateSession rationale.
			slog.Warn("bump agent session count failed (session_start)",
				"session_id", e.SessionID,
				"agent_id", e.AgentID,
				"err", bErr,
			)
		}
	}
	return nil
}

// HandleHeartbeat updates last_seen_at on the session.
func (sp *SessionProcessor) HandleHeartbeat(ctx context.Context, e consumer.EventPayload) error {
	if sp.handleSessionGuard(ctx, e) {
		return nil
	}
	return sp.w.UpdateLastSeen(ctx, e.SessionID)
}

// HandlePostCall updates token usage, last_seen_at, and the session's
// model field. The model column on sessions is not populated at
// session_start (the sensor doesn't know it yet); it is updated here
// from each post_call event so the API can return a non-null model
// for sessions that have made LLM calls. Failures in the model update
// are logged but do not abort processing -- the token update is
// load-bearing.
func (sp *SessionProcessor) HandlePostCall(ctx context.Context, e consumer.EventPayload) error {
	if sp.handleSessionGuard(ctx, e) {
		return nil
	}
	if e.Model != "" {
		if err := sp.w.UpdateSessionModel(ctx, e.SessionID, e.Model); err != nil {
			slog.Warn("update session model failed", "session_id", e.SessionID, "err", err)
		}
	}
	delta := 0
	if e.TokensTotal != nil {
		delta = *e.TokensTotal
	}
	if delta > 0 {
		if err := sp.w.UpdateTokensUsed(ctx, e.SessionID, delta); err != nil {
			return fmt.Errorf("post call: %w", err)
		}
		// D115 agent-level rollup. Non-fatal on error so a
		// transient UPDATE failure does not fail the whole event
		// -- the session-level tokens_used is authoritative, the
		// agent-level total_tokens is a dashboard convenience.
		if e.AgentID != "" {
			if aErr := sp.w.IncrementAgentTokens(ctx, e.AgentID, int64(delta)); aErr != nil {
				slog.Warn("increment agent tokens failed",
					"session_id", e.SessionID,
					"agent_id", e.AgentID,
					"err", aErr,
				)
			}
		}
	} else {
		if err := sp.w.UpdateLastSeen(ctx, e.SessionID); err != nil {
			return fmt.Errorf("post call: %w", err)
		}
	}
	return nil
}

// HandleSessionEnd closes the session. Unlike the other handlers,
// session_end deliberately bypasses handleTerminalGuard -- closing a
// stale or lost session should transition it directly to closed via
// CloseSession, not flicker through active. Already-closed sessions are
// an idempotent no-op.
//
// Phase 4 D2: orphan session_end (session_end for an unknown
// session_id) is now handled explicitly. Pre-Phase-4 behaviour was a
// silent FK-violation at InsertEvent → NATS Nak → redelivery loop → DLQ,
// with an opaque "process error" log that didn't distinguish "orphan"
// from "real problem". The new path looks up the session state before
// CloseSession runs; a missing row yields a WARN log + dropped-events
// counter increment + nil return so the consumer ACKs cleanly (there is
// nothing to recover from redelivery).
// HandleMCPServerAttached UPSERTs an MCP server fingerprint into
// ``sessions.context.mcp_servers`` (D140 step 6.6 A2). Routed
// from Process() alongside HandlePostCall (which advances
// last_seen_at) so the per-server dict lands and the dashboard
// SessionDrawer panel reflects it within ~2-3 s of attach via
// the existing fleet WebSocket re-fetch path.
//
// Maps the wire payload's ``server_name``/``server_url_canonical``
// to the existing context dict's ``name``/``server_url`` keys so
// the stored shape stays exactly what session_start writes
// (no schema bump). Idempotent at the SQL layer via
// AppendMCPServerToContext's (name, server_url) tuple dedup.
//
// Logs and continues on marshalling / DB failure — a malformed
// payload from a third-party emitter (validation already gates
// these at ingestion per Rule 36, but defensive logging keeps
// the worker resilient) must not block other event processing.
func (sp *SessionProcessor) HandleMCPServerAttached(
	ctx context.Context, e consumer.EventPayload,
) error {
	// Build the per-server dict matching the existing context shape.
	// Field omissions: AttachedAt (audit-only), Fingerprint (dedup-
	// only — D127 (canonical_url, name) tuple uniquely determines
	// it). The dashboard SessionDrawer reads this dict's name /
	// transport / protocol_version / version / capabilities /
	// instructions / server_url fields directly.
	dict := map[string]any{
		"name":         e.ServerName,
		"transport":    nilIfEmpty(e.Transport),
		"version":      nilIfEmpty(e.Version),
		"instructions": nilIfEmpty(e.Instructions),
		"server_url":   e.ServerURLCanonical,
	}
	if len(e.ProtocolVersion) > 0 {
		// Preserve source-type fidelity (str | int) by passing the
		// raw JSON bytes through — json.Marshal on map[string]any
		// will serialise json.RawMessage verbatim.
		dict["protocol_version"] = e.ProtocolVersion
	} else {
		dict["protocol_version"] = ""
	}
	if len(e.Capabilities) > 0 {
		dict["capabilities"] = e.Capabilities
	} else {
		dict["capabilities"] = map[string]any{}
	}

	dictBytes, err := json.Marshal(dict)
	if err != nil {
		slog.Warn("mcp_server_attached marshal dict",
			"session_id", e.SessionID, "err", err)
		return nil
	}
	if err := sp.w.AppendMCPServerToContext(
		ctx, e.SessionID, e.ServerName, e.ServerURLCanonical, dictBytes,
	); err != nil {
		slog.Warn("mcp_server_attached append failed",
			"session_id", e.SessionID,
			"server_name", e.ServerName,
			"err", err,
		)
	}
	return nil
}

// nilIfEmpty returns nil when s is the empty string, else s.
// Used to round-trip optional MCPServerFingerprint fields whose
// "absent" sentinel is "" on the wire but null in the dashboard's
// context dict (matches the existing shape's non-string fields'
// JSON null vs "" distinction).
func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (sp *SessionProcessor) HandleSessionEnd(ctx context.Context, e consumer.EventPayload) error {
	switch sp.sessionLookupState(ctx, e.SessionID) {
	case sessionLookupMissing:
		// D106 deliberately does NOT lazy-create on session_end -- a
		// teardown signal for a session we never saw should not
		// retroactively manifest a closed row. Log + counter + ACK.
		metrics.IncrDropped(metrics.ReasonOrphanSessionEnd)
		slog.Warn("dropped orphan session_end",
			"session_id", e.SessionID,
			"reason", string(metrics.ReasonOrphanSessionEnd),
		)
		return nil
	case sessionLookupClosed:
		// Duplicate session_end. Idempotent by design; log and skip.
		metrics.IncrDropped(metrics.ReasonClosedSessionSkip)
		slog.Warn("skipping event for closed session",
			"session_id", e.SessionID,
			"event_type", "session_end",
		)
		return nil
	}
	return sp.w.CloseSession(ctx, e.SessionID)
}

// StartReconciler runs a background loop every 60s to mark stale/lost
// sessions and to reap orphaned `lost` rows after `orphanTimeout`.
// The reaper closes sessions whose owning sensor / plugin never sent
// session_end (process crash, kill -9, missed lifecycle hook) and
// stamps close_reason="orphan_timeout" via a synthetic session_end so
// the dashboard's close-reason facet surfaces the reconciler's verdict
// alongside happy-path shutdowns.
func (sp *SessionProcessor) StartReconciler(
	ctx context.Context,
	orphanTimeout time.Duration,
) {
	ticker := time.NewTicker(reconcilerInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := sp.w.ReconcileStaleSessions(ctx); err != nil {
				slog.Error("reconciler error", "err", err)
			}
			reaped, err := sp.w.ReapOrphanedLostSessions(ctx, orphanTimeout)
			if err != nil {
				slog.Error("orphan reaper error", "err", err)
				continue
			}
			if reaped > 0 {
				metrics.IncrSessionClosedN(metrics.CloseReasonOrphanTimeout, uint64(reaped))
				slog.Info("reaped orphaned sessions",
					"count", reaped,
					"close_reason", string(metrics.CloseReasonOrphanTimeout),
					"timeout", orphanTimeout.String(),
				)
			}
		}
	}
}
