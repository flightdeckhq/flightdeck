// Package billing holds the billing-mode rules the worker applies to
// LLM events (ARCHITECTURE.md, Cost estimation).
package billing

import "slices"

// Billing modes. Only metered calls are counted in estimated cost.
const (
	Metered      = "metered"
	Subscription = "subscription"
	Local        = "local"
)

// SubscriptionClientTypes are the client types whose billing_mode
// default in the client type registry (contracts/client_types.json) is
// subscription: the clients normally paid for with a seat plan. A
// parity test pins this list to the registry.
var SubscriptionClientTypes = []string{"claude_code", "codex", "copilot", "cursor"}

// DefaultMode is the billing mode of an LLM call whose client sent none,
// by its client type's registry default: subscription for the seat-plan
// clients, metered for every other client.
func DefaultMode(clientType string) string {
	if slices.Contains(SubscriptionClientTypes, clientType) {
		return Subscription
	}
	return Metered
}

// Applies reports whether an event type is an LLM call that carries a
// billing mode: the events whose tokens estimated cost prices.
func Applies(eventType string) bool {
	return eventType == "post_call" || eventType == "embeddings"
}
