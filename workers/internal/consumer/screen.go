package consumer

import (
	"log/slog"

	"github.com/flightdeckhq/flightdeck/workers/internal/logcap"
	"github.com/flightdeckhq/flightdeck/workers/internal/metrics"
	"github.com/nats-io/nats.go"
)

// canonicalUUIDLen is the length of a UUID in its canonical 8-4-4-4-12
// hex form, the only form the ingestion API accepts for a session_id.
const canonicalUUIDLen = 36

// validSessionID reports whether s is a UUID in the canonical
// 8-4-4-4-12 hex form, in either case: the form the ingestion API
// enforces before it publishes an event. Any version and variant bits
// are accepted, as ingestion accepts them; Postgres's uuid type would
// also take braces or no hyphens, which ingestion refuses and so does
// this check.
func validSessionID(s string) bool {
	if len(s) != canonicalUUIDLen {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch i {
		case 8, 13, 18, 23:
			if c != '-' {
				return false
			}
		default:
			if !isHexDigit(c) {
				return false
			}
		}
	}
	return true
}

func isHexDigit(c byte) bool {
	return ('0' <= c && c <= '9') || ('a' <= c && c <= 'f') || ('A' <= c && c <= 'F')
}

// terminate settles msg for good: NATS does not redeliver it. Tests
// replace it through the term seam.
func (c *Consumer) terminate(msg *nats.Msg) {
	if c.term != nil {
		_ = c.term(msg)
		return
	}
	// A Term that fails to reach the server leaves the message
	// ack-pending until the ack wait expires; it is then redelivered
	// and refused again here, within the delivery budget.
	_ = msg.Term()
}

// dropInvalidSessionID refuses an event whose session_id is not a
// canonical UUID. Only a publisher that skipped the ingestion API can
// put one on the stream. Every delivery of it would fail at Postgres's
// uuid cast, so it is terminated on its first, before it takes a lane,
// counted, and logged once with the id capped: the id is the one field
// of the event the line needs, and the event's content is never logged.
func (c *Consumer) dropInvalidSessionID(msg *nats.Msg, event EventPayload) {
	metrics.IncrDropped(metrics.ReasonInvalidSessionID)
	var streamSeq uint64
	if meta, err := msg.Metadata(); err == nil {
		streamSeq = meta.Sequence.Stream
	}
	slog.Warn("dropped event with malformed session_id",
		"reason", string(metrics.ReasonInvalidSessionID),
		"event_type", logcap.EventType(event.EventType),
		"stream_seq", streamSeq,
		"session_id_len", len(event.SessionID),
		"session_id", logcap.ID(event.SessionID),
	)
	c.terminate(msg)
}
