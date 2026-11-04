package processor

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"math"

	"github.com/flightdeckhq/flightdeck/workers/internal/billing"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
)

// The keys of an llm_error's error object that report the tokens a stream
// had delivered, and the provider billed, before it failed
// (ARCHITECTURE.md, llm_error).
const (
	partialTokensInputKey  = "partial_tokens_input"
	partialTokensOutputKey = "partial_tokens_output"
)

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
	var fields map[string]json.RawMessage
	// directive_result's error is a plain string, and any error that
	// is not an object has no partial counts: nothing to apply.
	if json.Unmarshal(e.Error, &fields) != nil {
		return false
	}
	rawIn, rawOut := fields[partialTokensInputKey], fields[partialTokensOutputKey]
	if isAbsent(rawIn) && isAbsent(rawOut) {
		return false
	}
	in, okIn := storedTokenCount(rawIn)
	out, okOut := storedTokenCount(rawOut)
	if !okIn || !okOut || in > maxStoredTokens-out {
		// Ingestion refuses a count that is not an integer from 0 to
		// 2^53; one that still gets here (a client posting to an older
		// ingestion), or a sum past the INTEGER column, is not counted
		// rather than failing the event's insert.
		slog.Warn("llm_error partial tokens not a count the token columns hold; not counted",
			"session_id", e.SessionID, "event_id", e.ID)
		return false
	}
	total := in + out
	e.TokensInput, e.TokensOutput, e.TokensTotal = &in, &out, &total
	return total > 0
}

// isAbsent reports whether an error-object field is missing or JSON null.
func isAbsent(raw json.RawMessage) bool {
	return len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null"))
}

// storedTokenCount converts an optional partial count to a token column
// value: absent or null is 0; anything but a whole number in
// [0, maxStoredTokens] (a string, a fraction, a negative) is refused.
func storedTokenCount(raw json.RawMessage) (int, bool) {
	if isAbsent(raw) {
		return 0, true
	}
	var n float64
	if json.Unmarshal(raw, &n) != nil {
		return 0, false
	}
	if n < 0 || n > maxStoredTokens || n != math.Trunc(n) {
		return 0, false
	}
	return int(n), true
}

// failedStreamBillingMode is the billing mode of a failed stream's tokens
// when the llm_error carries none (a sensor that predates the field): the
// mode of the session's latest post_call (one of the same model first),
// else the client type's default. A mode the event brings is kept.
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
