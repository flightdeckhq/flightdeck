// Package nats provides a JetStream publisher for routing sensor events.
package nats

import (
	"fmt"

	"github.com/nats-io/nats.go"
)

const streamName = "FLIGHTDECK"

// Publisher publishes event payloads to NATS JetStream subjects.
type Publisher struct {
	js nats.JetStreamContext
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

// TODO(KI02)[Phase 2]: Events are lost if NATS is
// temporarily unavailable. Publish() returns an error,
// the sensor retries 3 times then drops the event.
// Fix: add a local WAL/buffer that stores events when
// NATS is down and replays them on reconnect.
// See DECISIONS.md D041.

// Publish sends data to the given NATS subject.
func (p *Publisher) Publish(subject string, data []byte) error {
	_, err := p.js.Publish(subject, data)
	if err != nil {
		return fmt.Errorf("publish to %s: %w", subject, err)
	}
	return nil
}

// SubjectForEventType maps an event_type string to a NATS subject.
//
// Examples: "session_start" → "events.session_start",
// "post_call" → "events.post_call".
func SubjectForEventType(eventType string) string {
	return "events." + eventType
}
