package processor

import (
	"context"
	"encoding/json"
	"log/slog"
	"math"

	"github.com/flightdeckhq/flightdeck/workers/internal/billing"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
)

// failedStreamUsage is the part of an llm_error's error object that
// reports the tokens a stream had delivered, and the provider billed,
// before it failed (ARCHITECTURE.md, llm_error).
type failedStreamUsage struct {
	PartialTokensInput  *float64 `json:"partial_tokens_input"`
	PartialTokensOutput *float64 `json:"partial_tokens_output"`
}

// maxStoredTokens is the largest count the events token columns hold:
// they are INTEGER, and a larger value would fail the row's insert on
// every redelivery.
const maxStoredTokens = math.MaxInt32

// applyFailedStreamTokens gives an llm_error that reports a failed
// stream's partial tokens those tokens as its own token fields, so the
// session and agent counters, analytics and cost count them like a
// call's. An event that sends top-level token counts keeps them (one
// report of the same tokens); every other event is left alone. It
// reports whether the event now carries a positive token total.
func applyFailedStreamTokens(e *consumer.EventPayload) bool {
	if e.EventType != "llm_error" || e.TokensTotal != nil || len(e.Error) == 0 {
		return false
	}
	var usage failedStreamUsage
	// directive_result's error is a plain string, and any error that
	// is not an object has no partial counts: nothing to apply.
	if json.Unmarshal(e.Error, &usage) != nil {
		return false
	}
	if usage.PartialTokensInput == nil && usage.PartialTokensOutput == nil {
		return false
	}
	in, okIn := storedTokenCount(usage.PartialTokensInput)
	out, okOut := storedTokenCount(usage.PartialTokensOutput)
	if !okIn || !okOut || in > maxStoredTokens-out {
		// Ingestion refuses a malformed count; one that still gets
		// here (a client older than that check) is not counted rather
		// than failing the event's insert.
		slog.Warn("llm_error partial tokens out of range; not counted",
			"session_id", e.SessionID, "event_id", e.ID)
		return false
	}
	total := in + out
	e.TokensInput, e.TokensOutput, e.TokensTotal = &in, &out, &total
	return total > 0
}

// storedTokenCount converts an optional partial count to a token column
// value: absent is 0, and anything but a whole number in
// [0, maxStoredTokens] is refused.
func storedTokenCount(v *float64) (int, bool) {
	if v == nil {
		return 0, true
	}
	n := *v
	if n < 0 || n > maxStoredTokens || n != math.Trunc(n) {
		return 0, false
	}
	return int(n), true
}

// failedStreamBillingMode is the billing mode of a failed stream's
// tokens, which the sensor does not stamp on an llm_error: the mode of
// the session's latest post_call (one of the same model first), else
// the client type's default.
func (p *Processor) failedStreamBillingMode(ctx context.Context, e consumer.EventPayload) (string, error) {
	mode, err := p.w.LatestCallBillingMode(ctx, e.SessionID, e.Model)
	if err != nil {
		return "", err
	}
	if mode != "" {
		return mode, nil
	}
	return billing.DefaultMode(e.ClientType), nil
}
