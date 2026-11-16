package writer

import (
	"bytes"
	"encoding/json"
	"log/slog"

	"github.com/flightdeckhq/flightdeck/workers/internal/logcap"
)

// contentSystem is a content blob's "system": the call's system prompt as
// its producer sent it. The JSON type picks the column: text is stored in
// event_content.system_prompt, and a list of content blocks (an Anthropic
// system in the form prompt caching uses, an OpenTelemetry GenAI
// framework's system instructions) in event_content.system_blocks, as the
// list. Text is never parsed to look for a list and a list is never
// written as text, so a text prompt that happens to read as JSON stays
// text. A value of any other JSON type is no system prompt a provider
// takes: it is dropped and the rest of the content is stored, with
// dropped naming its JSON type for the warning.
type contentSystem struct {
	text    *string
	blocks  json.RawMessage
	dropped string
}

// UnmarshalJSON reads the value by its JSON type. It refuses no
// well-formed value, so a system of an unexpected type never costs the
// call the rest of its content. encoding/json has checked the whole
// document before it calls this, so b is one well-formed value.
func (s *contentSystem) UnmarshalJSON(b []byte) error {
	*s = contentSystem{}
	v := bytes.TrimSpace(b)
	if len(v) == 0 {
		return nil
	}
	switch v[0] {
	case 'n': // null: no system prompt
	case '"':
		var text string
		if err := json.Unmarshal(v, &text); err != nil {
			return err
		}
		s.text = &text
	case '[':
		// Copied: the decoder reuses b once this returns.
		s.blocks = append(json.RawMessage(nil), v...)
	default:
		s.dropped = jsonKind(v[0])
	}
	return nil
}

// jsonKind names the JSON type of a value that is neither null, a string
// nor an array, from its first byte.
func jsonKind(first byte) string {
	switch first {
	case '{':
		return "object"
	case 't', 'f':
		return "boolean"
	default:
		return "number"
	}
}

// warnDroppedSystem logs a stored content's system that was dropped for
// its JSON type. It names the type, never the value: the value is
// captured content, which no log line carries.
func warnDroppedSystem(c eventContent, eventType, sessionID string) {
	if c.System.dropped == "" {
		return
	}
	slog.Warn("event content's system is neither text nor a list of content blocks; stored the content without it",
		"json_type", c.System.dropped,
		"event_type", logcap.EventType(eventType),
		"session_id", logcap.ID(sessionID))
}
