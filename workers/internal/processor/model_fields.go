package processor

import (
	"github.com/flightdeckhq/flightdeck/workers/internal/billing"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/modelid"
)

// normalizeModelFields applies the write-path model rules
// (ARCHITECTURE.md, Cost estimation) to an event before anything reads
// its model:
//
//   - an LLM call without a billing mode gets its client's default;
//   - the raw id is kept as model_requested (the legacy model field, or
//     the served id when the client sent nothing else), so every row
//     that names a model has one and the backfill never revisits it;
//   - model becomes the canonical id of the served, else the requested
//     id, and a Bedrock region prefix fills inference_scope;
//   - an event that names a model gets a provider derived from it when
//     the client sent none.
func normalizeModelFields(e *consumer.EventPayload) {
	if e.BillingMode == "" && billing.Applies(e.EventType) {
		e.BillingMode = billing.DefaultMode(e.ClientType)
	}
	if e.ModelRequested == "" {
		e.ModelRequested = e.Model
	}
	if e.ModelRequested == "" {
		e.ModelRequested = e.ModelServed
	}
	source := e.ModelServed
	if source == "" {
		source = e.ModelRequested
	}
	if source == "" {
		return
	}
	c := modelid.Canonicalize(source)
	e.Model = c.Model
	if e.InferenceScope == "" {
		e.InferenceScope = c.InferenceScope
	}
	if e.Provider == "" && e.Model != "" {
		e.Provider = modelid.Provider(e.Model)
	}
}
