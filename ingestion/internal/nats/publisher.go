// Package nats provides a JetStream publisher for routing sensor events.
package nats

import (
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/nats-io/nats.go"
)

const streamName = "FLIGHTDECK"

// natsRetryDelays governs the per-publish retry schedule on NATS
// JetStream errors: three attempts with exponential backoff.
// Total worst-case latency added on a 3-fail-then-succeed path:
// 100 + 200 + 400 = 700 ms. Phase 4.5 N-4: extracted to package
// level so the schedule is visible in one place rather than
// inlined inside Publish.
var natsRetryDelays = []time.Duration{
	100 * time.Millisecond,
	200 * time.Millisecond,
	400 * time.Millisecond,
}

// Publisher publishes event payloads to NATS JetStream subjects.
type Publisher struct {
	js         nats.JetStreamContext
	lostEvents atomic.Int64
}

// NewPublisher creates a Publisher, ensuring the FLIGHTDECK stream exists.
func NewPublisher(nc *nats.Conn) (*Publisher, error) {
	js, err := nc.JetStream()
	if err != nil {
		return nil, fmt.Errorf("jetstream context: %w", err)
	}

	// Create the stream if it does not exist; update if it does.
	_, err = js.AddStream(&nats.StreamConfig{
		Name:     streamName,
		Subjects: []string{"events.>"},
		Storage:  nats.FileStorage,
	})
	if err != nil {
		return nil, fmt.Errorf("ensure stream %s: %w", streamName, err)
	}

	return &Publisher{js: js}, nil
}

// Publish sends data to the given NATS subject with retry on failure.
// On persistent failure after 3 attempts: logs the loss and returns nil
// to avoid blocking the ingestion response.
func (p *Publisher) Publish(subject string, data []byte) error {
	var lastErr error

	for attempt := range len(natsRetryDelays) + 1 {
		_, err := p.js.Publish(subject, data)
		if err == nil {
			return nil
		}
		lastErr = err
		if attempt < len(natsRetryDelays) {
			time.Sleep(natsRetryDelays[attempt])
		}
	}

	// All retries exhausted -- log the loss and continue
	p.lostEvents.Add(1)
	slog.Error("NATS publish failed after retries, event lost",
		"subject", subject,
		"attempts", len(natsRetryDelays)+1,
		"err", lastErr,
		"total_lost", p.lostEvents.Load(),
	)
	return nil
}

// LostEvents returns the total number of events lost due to publish failures.
func (p *Publisher) LostEvents() int64 {
	return p.lostEvents.Load()
}

// SubjectForEventType maps an event_type string to a NATS subject.
//
// Examples: "session_start" → "events.session_start",
// "post_call" → "events.post_call".
func SubjectForEventType(eventType string) string {
	return "events." + eventType
}
