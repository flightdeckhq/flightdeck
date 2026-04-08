package processor

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
	"github.com/jackc/pgx/v5/pgxpool"
)

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
	case "directive_result":
		// Insert event but do NOT evaluate policy. Just update last_seen.
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
	eventID, err := p.w.InsertEvent(
		ctx, e.SessionID, e.Flavor, e.EventType, e.Model,
		e.TokensInput, e.TokensOutput, e.TokensTotal,
		e.LatencyMs, e.ToolName, e.HasContent, ts,
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

	// NOTIFY for real-time dashboard push
	if err := writer.NotifyFleetChange(ctx, p.pool, e.SessionID, e.EventType); err != nil {
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
