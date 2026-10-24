// Package billing holds the billing-mode rules the worker applies to
// LLM events (ARCHITECTURE.md, Cost estimation).
package billing

// Billing modes. Only metered calls are counted in estimated cost.
const (
	Metered      = "metered"
	Subscription = "subscription"
	Local        = "local"
)

const clientTypeClaudeCode = "claude_code"

// DefaultMode is the billing mode of an LLM call whose client sent none,
// by its session's client type: a Claude Code session runs on the
// developer's subscription unless the plugin says otherwise; every
// other client calls a metered API.
func DefaultMode(clientType string) string {
	if clientType == clientTypeClaudeCode {
		return Subscription
	}
	return Metered
}

// Applies reports whether an event type is an LLM call that carries a
// billing mode: the events whose tokens estimated cost prices.
func Applies(eventType string) bool {
	return eventType == "post_call" || eventType == "embeddings"
}
