package processor

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
	"github.com/jackc/pgx/v5/pgxpool"
)

// BuildEventExtra projects per-event-type metadata fields from a NATS
// payload into the events.payload JSONB column. Returns nil for events
// that have no extra metadata to persist (e.g. session_start, post_call,
// tool_call). Returns a JSON-encoded map for directive_result events
// containing directive_name, directive_action, directive_status,
// result, error, duration_ms -- omitting any field that is empty/nil.
//
// This is an exported helper so it can be unit-tested directly without
// needing to wire a mock writer through the Processor.
func BuildEventExtra(e consumer.EventPayload) ([]byte, error) {
	// Pre-Phase-4 this function only produced payload for
	// directive_result events. Phase 4 opens it up to any event that
	// carries structured extras -- llm_error events populate
	// ``error`` with the Phase 4 taxonomy object, streaming post_call
	// events populate ``streaming`` with TTFT + chunk stats. The
	// per-field guards below skip any field the event doesn't carry,
	// so non-directive events that also have no Phase 4 extras
	// short-circuit out via ``if len(extra) == 0`` at the bottom and
	// the payload column stays NULL -- matching the prior behaviour
	// for those events exactly.
	extra := make(map[string]interface{})
	if e.DirectiveName != "" {
		extra["directive_name"] = e.DirectiveName
	}
	if e.DirectiveAction != "" {
		extra["directive_action"] = e.DirectiveAction
	}
	if e.DirectiveStatus != "" {
		extra["directive_status"] = e.DirectiveStatus
	}
	if len(e.Result) > 0 {
		// Result is a json.RawMessage -- decode and re-attach so the
		// final encoded payload is a single document, not a string.
		var v interface{}
		if err := json.Unmarshal(e.Result, &v); err == nil {
			extra["result"] = v
		}
	}
	if len(e.Error) > 0 {
		// ``Error`` is json.RawMessage (Phase 4) to carry either the
		// legacy directive_result string OR the structured llm_error
		// object. Unmarshal back to an interface so the encoded
		// payload is one document.
		var v interface{}
		if err := json.Unmarshal(e.Error, &v); err == nil {
			extra["error"] = v
		}
	}
	if e.DurationMs != nil {
		extra["duration_ms"] = *e.DurationMs
	}
	if len(e.Streaming) > 0 {
		// Phase 4 streaming sub-object. Same shape handling as Error
		// above: decode + re-attach so the final payload is a single
		// JSON document.
		var v interface{}
		if err := json.Unmarshal(e.Streaming, &v); err == nil {
			extra["streaming"] = v
		}
	}
	// Policy enforcement fields (policy_warn / policy_degrade /
	// policy_block). Emit only when populated so non-policy events keep
	// their existing payload shape.
	if e.Source != "" {
		extra["source"] = e.Source
	}
	if e.ThresholdPct != nil {
		extra["threshold_pct"] = *e.ThresholdPct
	}
	if e.TokensUsed != nil {
		extra["tokens_used"] = *e.TokensUsed
	}
	if e.TokenLimit != nil {
		extra["token_limit"] = *e.TokenLimit
	}
	if e.FromModel != "" {
		extra["from_model"] = e.FromModel
	}
	if e.ToModel != "" {
		extra["to_model"] = e.ToModel
	}
	if e.IntendedModel != "" {
		extra["intended_model"] = e.IntendedModel
	}
	if len(extra) == 0 {
		return nil, nil
	}
	return json.Marshal(extra)
}

// Processor routes incoming events to the session processor, writer,
// and policy evaluator.
type Processor struct {
	session *SessionProcessor
	policy  *PolicyEvaluator
	w       *writer.Writer
	pool    *pgxpool.Pool
}

// NewProcessor creates a fully wired Processor.
func NewProcessor(pool *pgxpool.Pool) *Processor {
	w := writer.New(pool)
	return &Processor{
		session: NewSessionProcessor(w, pool),
		policy:  NewPolicyEvaluator(pool),
		w:       w,
		pool:    pool,
	}
}

// Process handles a single event from NATS.
func (p *Processor) Process(ctx context.Context, e consumer.EventPayload) error {
	// Route to the correct session handler
	switch e.EventType {
	case "session_start":
		if err := p.session.HandleSessionStart(ctx, e); err != nil {
			return err
		}
	case "session_end":
		if err := p.session.HandleSessionEnd(ctx, e); err != nil {
			return err
		}
	case "heartbeat":
		if err := p.session.HandleHeartbeat(ctx, e); err != nil {
			return err
		}
	case "post_call", "pre_call", "tool_call":
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
	case "embeddings":
		// Phase 4 addition. Embeddings are a post_call-shaped event
		// with no completion tokens; the ingestion layer validated
		// the schema so we route through the same last-seen + tokens
		// update path. Policy does not evaluate (separate budget
		// surface if ever added; out of scope for Phase 4).
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
	case "llm_error":
		// Phase 4 addition. Structured LLM API error. Route through
		// the same last-seen update path so the session's freshness
		// advances on failed calls too -- otherwise a session that
		// only ever produces errors would age to stale.
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
	case "directive_result":
		// Insert event but do NOT evaluate policy. Just update last_seen.
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
	case "policy_warn", "policy_degrade", "policy_block":
		// Policy enforcement events emitted by the sensor's _pre_call
		// (WARN, BLOCK) and _apply_directive(DEGRADE). Route through
		// HandlePostCall so last_seen_at advances on enforcement
		// activity. Policy is NOT re-evaluated — these events ARE the
		// evaluation outcome; the worker would otherwise emit a
		// duplicate directive.
		if err := p.session.HandlePostCall(ctx, e); err != nil {
			return err
		}
	default:
		return fmt.Errorf("unknown event_type: %s", e.EventType)
	}

	// Insert the event record
	ts, err := time.Parse(time.RFC3339, e.Timestamp)
	if err != nil {
		ts = time.Now().UTC()
	}
	extra, extraErr := BuildEventExtra(e)
	if extraErr != nil {
		// Non-fatal: log and proceed without payload metadata.
		slog.Warn("build event extra error", "err", extraErr, "event_type", e.EventType)
	}
	eventID, err := p.w.InsertEvent(
		ctx, e.SessionID, e.Flavor, e.EventType, e.Model,
		e.TokensInput, e.TokensOutput, e.TokensTotal,
		e.TokensCacheRead, e.TokensCacheCreation,
		e.LatencyMs, e.ToolName, e.HasContent, ts, extra,
	)
	if err != nil {
		return err
	}

	// Store prompt content when capture is enabled
	if e.HasContent && len(e.Content) > 0 {
		if err := p.w.InsertEventContent(ctx, eventID, e.SessionID, e.Content); err != nil {
			slog.Warn("insert event content error", "err", err)
		}
	}

	// NOTIFY for real-time dashboard push. eventID is the one just
	// returned by InsertEvent above -- the hub fetches exactly this
	// row by primary key, avoiding the NOTIFY->SELECT race where
	// GetSessionEvents + tail would return a later event under
	// tight paired writes.
	if err := writer.NotifyFleetChange(ctx, p.pool, e.SessionID, e.EventType, eventID); err != nil {
		// Non-fatal: log but don't fail the event
		slog.Warn("notify error", "err", err)
	}

	// Evaluate policy after post_call events
	if e.EventType == "post_call" {
		if err := p.policy.Evaluate(ctx, e.SessionID); err != nil {
			// Non-fatal: log but don't fail the event
			slog.Warn("policy eval error", "err", err)
		}
	}

	return nil
}

// StartReconciler delegates to the session processor's background reconciler.
func (p *Processor) StartReconciler(ctx context.Context) {
	p.session.StartReconciler(ctx)
}
