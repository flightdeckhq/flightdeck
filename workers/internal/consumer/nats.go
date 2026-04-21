// Package consumer provides a NATS JetStream consumer goroutine pool.
package consumer

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"

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
	Error           string          `json:"error,omitempty"`
	DurationMs      *int64          `json:"duration_ms,omitempty"`

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
			if err == nats.ErrTimeout || err == context.Canceled {
				continue
			}
			slog.Error("fetch error", "worker", id, "err", err)
			continue
		}

		for _, msg := range msgs {
			var event EventPayload
			if err := json.Unmarshal(msg.Data, &event); err != nil {
				slog.Error("unmarshal error", "worker", id, "err", err)
				_ = msg.Term()
				continue
			}

			if err := c.processor.Process(ctx, event); err != nil {
				slog.Error("process error", "worker", id, "event_type", event.EventType, "err", err)
				_ = msg.Nak()
				continue
			}

			_ = msg.Ack()
		}
	}
}
