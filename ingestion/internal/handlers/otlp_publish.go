package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/auth"
	inats "github.com/flightdeckhq/flightdeck/ingestion/internal/nats"
)

// OTLPPublisher is the receiver's publish path for events mapped outside
// a request: the OTLP GenAI assembler publishes the events it maps from
// a staged trace through it, as the receiver publishes a dialect's, so
// they are validated, cut, stamped with their token and attached the
// same way.
type OTLPPublisher struct {
	publisher EventPublisher
	attacher  SessionAttacher
}

// NewOTLPPublisher returns the publish path over publisher and attacher.
func NewOTLPPublisher(publisher EventPublisher, attacher SessionAttacher) *OTLPPublisher {
	return &OTLPPublisher{publisher: publisher, attacher: attacher}
}

// Encode encodes one mapped event, cutting its content to fit the event
// size limit, and validates it exactly as POST /v1/events validates a
// posted one, at now. It returns the body, or the validation message.
func (p *OTLPPublisher) Encode(payload map[string]any, now time.Time) ([]byte, string) {
	return finishOTLPEvent(payload, now)
}

// OldestValid is the oldest event timestamp validation accepts at now.
func (p *OTLPPublisher) OldestValid(now time.Time) time.Time {
	return now.Add(-maxClockSkewPast)
}

// Publish publishes events in order as sent by token, and returns how
// many it published before the first failure (see publishOTLPEvents).
func (p *OTLPPublisher) Publish(ctx context.Context, token auth.ValidationResult, events []OTLPEvent) (int, error) {
	return publishOTLPEvents(ctx, p.publisher, p.attacher, token, events)
}

// errOTLPPublishGivenUp reports a publish the publisher gave up on: it
// returned no error but no stream sequence either.
type errOTLPPublishGivenUp struct{ subject string }

func (e errOTLPPublishGivenUp) Error() string {
	return "publish to " + e.subject + " was given up on"
}

// publishOTLPEvents publishes events in order and returns how many it
// published before the first failure. A publish that reports no stream
// sequence was given up on by the publisher and counts as a failure,
// so the exporter retries the request rather than losing its events;
// the events' deterministic ids make the retry safe.
//
// A session_start goes out as POST /v1/events sends one: stamped with
// the id and name of the token that sent it, after the synchronous
// session-attachment check (which revives a closed row), and, when it
// re-attaches, with its stream sequence recorded on the row. A start
// marked SkipAttach skips the check, and so the sequence too.
func publishOTLPEvents(
	ctx context.Context,
	publisher EventPublisher,
	attacher SessionAttacher,
	token auth.ValidationResult,
	events []OTLPEvent,
) (int, error) {
	for i, ev := range events {
		payload := ev.Payload
		attached := false
		if ev.EventType == "session_start" {
			var err error
			if payload, err = stampSessionStartToken(payload, token); err != nil {
				return i, err
			}
			if !ev.SkipAttach {
				attached = attachSession(ctx, attacher, ev.SessionID, eventIDOf(payload))
			}
		}
		subject := inats.SubjectForEventType(ev.EventType)
		seq, err := publisher.Publish(subject, payload)
		if err != nil {
			return i, err
		}
		if seq == 0 {
			return i, errOTLPPublishGivenUp{subject: subject}
		}
		if attached {
			if err := attacher.RecordStart(ctx, ev.SessionID, eventIDOf(payload), seq); err != nil {
				slog.Warn("record session_start sequence failed",
					"session_id", ev.SessionID, "seq", seq, "err", err)
			}
		}
	}
	return len(events), nil
}

// stampSessionStartToken adds the sending token's id and name to a
// session_start, which the worker stores on the session row. Only those
// two fields are encoded (see patchJSON), so every number in the event
// keeps its literal, as it does on POST /v1/events.
func stampSessionStartToken(payload []byte, token auth.ValidationResult) ([]byte, error) {
	if token.ID == "" {
		return payload, nil
	}
	stamped, err := patchJSON(payload, []rawEdit{
		{path: []string{"token_id"}, value: token.ID},
		{path: []string{"token_name"}, value: token.Name},
	})
	if err != nil {
		return nil, fmt.Errorf("stamp session_start token: %w", err)
	}
	return stamped, nil
}

// eventIDOf reads the id of an event payload, "" when it has none. The
// dialects derive a session_start's id from the session and its first
// record, so an exporter that retries a batch sends the same id, which
// the attach treats as one start.
func eventIDOf(payload []byte) string {
	var ev struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(payload, &ev); err != nil {
		return ""
	}
	return ev.ID
}

// attachSession runs the session-attachment check for a session_start
// and reports whether it attached to an existing row. A failed check is
// logged and treated as not attached: the flag is informational and the
// event must still flow.
func attachSession(ctx context.Context, attacher SessionAttacher, sessionID, eventID string) bool {
	if attacher == nil {
		return false
	}
	attached, priorState, err := attacher.Attach(ctx, sessionID, eventID)
	if err != nil {
		slog.Error("session attach lookup failed", "session_id", sessionID, "err", err)
		return false
	}
	if attached && (priorState == "closed" || priorState == "lost") {
		slog.Info("session revived", "session_id", sessionID, "prior_state", priorState)
	}
	return attached
}
