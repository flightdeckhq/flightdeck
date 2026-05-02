// Package consumer provides a NATS JetStream consumer goroutine pool.
package consumer

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"

	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
	"github.com/nats-io/nats.go"
)

const (
	streamName   = "FLIGHTDECK"
	durableName  = "flightdeck-workers"
	subjectAll   = "events.>"
	maxDeliver   = 3
)

// EventPayload is the raw event received from NATS.
//
// The Directive* fields are populated for directive_result events
// emitted by the sensor when it acknowledges or executes a directive
// (D072). They are JSON-decoded directly from the top-level keys on
// the event payload that the sensor POSTs to /v1/events. The worker
// processor projects these fields into the events.payload JSONB
// column via processor.BuildEventExtra().
type EventPayload struct {
	SessionID       string          `json:"session_id"`
	Flavor          string          `json:"flavor"`
	AgentType       string          `json:"agent_type"`
	// D115 identity fields. The ingestion API validates agent_id is
	// a canonical UUID, and agent_type / client_type are from their
	// respective D114 / D116 vocabularies, so by the time the worker
	// sees a payload here these values are known-good.
	AgentID         string          `json:"agent_id"`
	AgentName       string          `json:"agent_name"`
	ClientType      string          `json:"client_type"`
	User            string          `json:"user"`
	Hostname        string          `json:"hostname"`
	EventType       string          `json:"event_type"`
	Host            string          `json:"host"`
	Framework       string          `json:"framework"`
	Model           string          `json:"model"`
	TokensInput     *int            `json:"tokens_input"`
	TokensOutput    *int            `json:"tokens_output"`
	TokensTotal     *int            `json:"tokens_total"`
	// D100: Anthropic cache-token breakdown. Populated by the Python sensor's
	// AnthropicProvider.extract_usage and by the Claude Code plugin's
	// transcript reader. Absent on OpenAI events and on non-LLM events.
	TokensCacheRead     *int64      `json:"tokens_cache_read,omitempty"`
	TokensCacheCreation *int64      `json:"tokens_cache_creation,omitempty"`
	TokensUsedSess  int             `json:"tokens_used_session"`
	TokenLimitSess  *int            `json:"token_limit_session"`
	LatencyMs       *int            `json:"latency_ms"`
	ToolName        *string         `json:"tool_name"`
	HasContent      bool            `json:"has_content"`
	Content         json.RawMessage `json:"content"`
	Timestamp       string          `json:"timestamp"`

	// Directive metadata (directive_result events only).
	DirectiveName   string          `json:"directive_name,omitempty"`
	DirectiveAction string          `json:"directive_action,omitempty"`
	DirectiveStatus string          `json:"directive_status,omitempty"`
	Result          json.RawMessage `json:"result,omitempty"`
	// ``Error`` is overloaded between directive_result (plain string) and
	// Phase 4 llm_error (structured taxonomy object). Accept both via
	// json.RawMessage so unmarshal cannot fail on either shape; the
	// event-extra builder preserves it verbatim into the payload JSONB
	// column for the dashboard to narrow via typeof.
	Error           json.RawMessage `json:"error,omitempty"`
	DurationMs      *int64          `json:"duration_ms,omitempty"`
	// Phase 4: optional streaming sub-object on post_call events.
	// Populated by the sensor's GuardedStream / GuardedAsyncStream
	// with TTFT + chunk stats + final_outcome. Absent for non-stream
	// calls so the wire shape is unchanged for callers that never
	// stream.
	Streaming       json.RawMessage `json:"streaming,omitempty"`

	// Policy enforcement event metadata (policy_warn / policy_degrade /
	// policy_block). Populated by the sensor's _pre_call (WARN, BLOCK)
	// and _apply_directive(DEGRADE). All three event types share the
	// (source, threshold_pct, tokens_used, token_limit) common shape;
	// DEGRADE adds (from_model, to_model) and BLOCK adds intended_model.
	// Absent on every other event type so the wire shape is unchanged
	// for non-policy paths.
	Source         string  `json:"source,omitempty"`
	ThresholdPct   *int    `json:"threshold_pct,omitempty"`
	TokensUsed     *int64  `json:"tokens_used,omitempty"`
	TokenLimit     *int64  `json:"token_limit,omitempty"`
	FromModel      string  `json:"from_model,omitempty"`
	ToModel        string  `json:"to_model,omitempty"`
	IntendedModel  string  `json:"intended_model,omitempty"`

	// Runtime context collected by the sensor at init() time and by
	// the Claude Code plugin on every hook invocation. Populated on
	// any event type that carries it; session_start calls
	// UpsertSession's COALESCE-enriched ON CONFLICT branch, and every
	// other event type calls UpgradeSessionContext to fill in the
	// context column when a prior session_start never landed (e.g.,
	// the plugin's session_start POST failed because the stack was
	// down at process start -- D106 lazy-creates the row with NULL
	// context, and a later event's context finally populates it).
	Context map[string]interface{} `json:"context,omitempty"`

	// Token attribution (D095). Injected by the ingestion API on
	// session_start events only -- the API resolves the authenticating
	// access_tokens row and stamps the id/name into the payload before
	// publishing to NATS. UpsertSession persists them onto the new
	// session row so the dashboard can render "Created via: $NAME"
	// without joining access_tokens and so the label survives token
	// revocation. Other event types leave these fields empty and the
	// worker does not touch the session's token columns.
	TokenID   string `json:"token_id,omitempty"`
	TokenName string `json:"token_name,omitempty"`

	// Phase 5 MCP fields. Populated by the sensor's MCP interceptor on
	// the six MCP_* event types only. Lean payload (Phase 5 override 2):
	// these are the only MCP-specific fields on the wire; the LLM-
	// baseline tokens_input/output/total/cache_*, model, latency_ms,
	// tool_input, tool_result, has_content, content fields are absent
	// from MCP event payloads entirely. ServerName + Transport identify
	// which MCP server the call hit; DurationMs (already declared above
	// for directive_result events) doubles as MCP-call latency.
	//
	// MCP_TOOL_LIST / MCP_RESOURCE_LIST / MCP_PROMPT_LIST: ServerName,
	// Transport, Count.
	// MCP_TOOL_CALL: ServerName, Transport, ToolName (top-level — also
	// populated into events.tool_name column for filter compatibility),
	// Arguments + Result (gated by capture_prompts).
	// MCP_RESOURCE_READ: ServerName, Transport, ResourceURI,
	// ContentBytes (always — size, not contents), MimeType + Content
	// (gated).
	// MCP_PROMPT_GET: ServerName, Transport, PromptName, Arguments +
	// Rendered (gated).
	// Failure path on any of the above: Error projects via the existing
	// Error json.RawMessage field, classified by the sensor's MCP
	// taxonomy (invalid_params / connection_closed / timeout / api_error
	// / other).
	ServerName   string          `json:"server_name,omitempty"`
	Transport    string          `json:"transport,omitempty"`
	Count        *int            `json:"count,omitempty"`
	Arguments    json.RawMessage `json:"arguments,omitempty"`
	ResourceURI  string          `json:"resource_uri,omitempty"`
	ContentBytes *int64          `json:"content_bytes,omitempty"`
	MimeType     string          `json:"mime_type,omitempty"`
	PromptName   string          `json:"prompt_name,omitempty"`
	Rendered     json.RawMessage `json:"rendered,omitempty"`
}

// Processor processes a single event payload.
type Processor interface {
	Process(ctx context.Context, event EventPayload) error
}

// Consumer subscribes to NATS JetStream and dispatches events
// to a Processor using a goroutine pool.
type Consumer struct {
	nc        *nats.Conn
	poolSize  int
	processor Processor
}

// New creates a Consumer.
func New(nc *nats.Conn, poolSize int, processor Processor) *Consumer {
	return &Consumer{nc: nc, poolSize: poolSize, processor: processor}
}

// Start begins consuming messages. Blocks until ctx is cancelled.
func (c *Consumer) Start(ctx context.Context) error {
	js, err := c.nc.JetStream()
	if err != nil {
		return fmt.Errorf("jetstream context: %w", err)
	}

	// Ensure the stream exists (may be created by ingestion first, or by us)
	_, err = js.AddStream(&nats.StreamConfig{
		Name:     streamName,
		Subjects: []string{"events.>"},
		Storage:  nats.FileStorage,
	})
	if err != nil {
		return fmt.Errorf("ensure stream %s: %w", streamName, err)
	}

	sub, err := js.PullSubscribe(subjectAll, durableName, nats.MaxDeliver(maxDeliver))
	if err != nil {
		return fmt.Errorf("pull subscribe: %w", err)
	}

	var wg sync.WaitGroup
	for i := range c.poolSize {
		wg.Add(1)
		go func(workerID int) {
			defer wg.Done()
			c.worker(ctx, sub, workerID)
		}(i)
	}

	<-ctx.Done()
	wg.Wait()
	return nil
}

func (c *Consumer) worker(ctx context.Context, sub *nats.Subscription, id int) {
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		msgs, err := sub.Fetch(1, nats.MaxWait(nats.DefaultTimeout))
		if err != nil {
			// Phase 4.5 N-3: errors.Is unwraps wrapped sentinels;
			// direct `==` would miss a future caller that wraps the
			// error to add context.
			if errors.Is(err, nats.ErrTimeout) || errors.Is(err, context.Canceled) {
				continue
			}
			slog.Error("fetch error", "worker", id, "err", err)
			continue
		}

		for _, msg := range msgs {
			var event EventPayload
			if err := json.Unmarshal(msg.Data, &event); err != nil {
				metrics.IncrDropped(metrics.ReasonUnmarshalError)
				slog.Error("unmarshal error", "worker", id, "err", err)
				_ = msg.Term()
				continue
			}

			if err := c.processor.Process(ctx, event); err != nil {
				// Phase 4: when the JetStream delivery count has
				// crossed maxDeliver, the message is about to go to
				// the DLQ rather than be redelivered again. Bump a
				// distinct counter so operators can see
				// retries-exhausted distinct from per-attempt errors.
				// Use NumDelivered on the message metadata -- NATS
				// increments it per delivery, starting at 1.
				if meta, mErr := msg.Metadata(); mErr == nil && meta.NumDelivered >= maxDeliver {
					metrics.IncrDropped(metrics.ReasonMaxRetriesExhausted)
				}
				slog.Error("process error", "worker", id, "event_type", event.EventType, "err", err)
				_ = msg.Nak()
				continue
			}

			_ = msg.Ack()
		}
	}
}
