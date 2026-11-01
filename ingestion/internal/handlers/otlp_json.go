package handlers

import (
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// otlpHexIDFields are the bytes fields OTLP JSON encodes as hex rather
// than protojson's base64: the trace and span ids of spans, span links,
// log records and exemplars. Both the lowerCamelCase names OTLP JSON
// uses and the proto field names protojson also accepts are listed.
// The names never collide with attribute keys, which OTLP JSON carries
// as {"key": ..., "value": ...} objects rather than as object keys.
var otlpHexIDFields = map[string]bool{
	"traceId":        true,
	"spanId":         true,
	"parentSpanId":   true,
	"trace_id":       true,
	"span_id":        true,
	"parent_span_id": true,
}

// OTLP id lengths in hex: a span id is 8 bytes and a trace id 16; an
// empty id is an absent one. Holding ids to these lengths is what lets
// the rewrite run in place: their base64 form is always shorter.
const (
	otlpSpanIDHexLen  = 16
	otlpTraceIDHexLen = 32
)

// otlpJSONUnmarshal ignores fields it does not know: OTLP receivers
// must accept requests from exporters built against a newer proto.
var otlpJSONUnmarshal = protojson.UnmarshalOptions{DiscardUnknown: true}

// errOTLPInvalidJSON marks a body that is not OTLP JSON (400).
var errOTLPInvalidJSON = errors.New("invalid OTLP JSON")

// unmarshalOTLPJSON decodes an OTLP JSON request body into msg. OTLP
// JSON is protojson with two differences: trace and span ids are hex,
// not base64, and enums may be integers (protojson accepts those as
// is). The ids are re-encoded as base64 in place before protojson reads
// the body, which body therefore no longer holds afterwards. A body
// whose decode would take more than maxOTLPDecodeHeapBytes is refused
// with errOTLPDecodeTooLarge before protojson allocates anything.
func unmarshalOTLPJSON(body []byte, msg proto.Message) error {
	converted, _, err := rewriteOTLPJSONIDs(body)
	if err != nil {
		return err
	}
	if err := otlpJSONUnmarshal.Unmarshal(converted, msg); err != nil {
		return fmt.Errorf("%w: %w", errOTLPInvalidJSON, err)
	}
	return nil
}

// otlpJSONFrame is one open object or array of the rewrite's walk.
type otlpJSONFrame struct {
	object    bool
	expectKey bool // an object frame between members
	idValue   bool // an object frame whose last key is a hex id field
}

// rewriteOTLPJSONIDs walks body once, without building a tree, and
// returns it compacted in place (insignificant whitespace dropped) with
// every hex id value re-encoded as base64. It only tracks what it must
// to tell keys from values; protojson validates the rest. The walk
// also bounds what decoding will cost: every object becomes a message
// and every scalar an element, and a body whose estimate passes
// maxOTLPDecodeHeapBytes is refused, as is one nested deeper than
// maxOTLPNestingDepth.
func rewriteOTLPJSONIDs(body []byte) ([]byte, int64, error) {
	var (
		stack   = make([]otlpJSONFrame, 0, maxOTLPNestingDepth)
		r, w    int
		heap    = int64(len(body))
		scratch [otlpTraceIDHexLen / 2]byte
	)
	charge := func(n int64) error {
		heap += n
		if heap > maxOTLPDecodeHeapBytes {
			return errOTLPDecodeTooLarge
		}
		return nil
	}
	top := func() *otlpJSONFrame {
		if len(stack) == 0 {
			return nil
		}
		return &stack[len(stack)-1]
	}

	for r < len(body) {
		c := body[r]
		switch c {
		case ' ', '\t', '\n', '\r':
			r++
			continue
		case '{', '[':
			if len(stack) == maxOTLPNestingDepth {
				return nil, 0, fmt.Errorf("%w: nested deeper than %d", errOTLPInvalidJSON, maxOTLPNestingDepth)
			}
			if c == '{' {
				if err := charge(otlpHeapPerMessage); err != nil {
					return nil, 0, err
				}
			}
			stack = append(stack, otlpJSONFrame{object: c == '{', expectKey: c == '{'})
			body[w] = c
			r, w = r+1, w+1
		case '}', ']':
			f := top()
			if f == nil || f.object != (c == '}') {
				return nil, 0, fmt.Errorf("%w: unbalanced %q", errOTLPInvalidJSON, c)
			}
			stack = stack[:len(stack)-1]
			body[w] = c
			r, w = r+1, w+1
		case ',', ':':
			if f := top(); f != nil && f.object && c == ',' {
				f.expectKey = true
			}
			body[w] = c
			r, w = r+1, w+1
		case '"':
			end, escaped, err := scanJSONString(body, r)
			if err != nil {
				return nil, 0, err
			}
			f := top()
			switch {
			case f != nil && f.object && f.expectKey:
				// A member name. The map lookup with a converted byte
				// slice does not allocate.
				f.expectKey = false
				f.idValue = !escaped && otlpHexIDFields[string(body[r+1:end-1])]
				w += copy(body[w:], body[r:end])
			case f != nil && f.object && f.idValue:
				f.idValue = false
				if err := charge(otlpHeapPerJSONScalar); err != nil {
					return nil, 0, err
				}
				n, err := hexIDToBase64InPlace(body, r, end, w, escaped, &scratch)
				if err != nil {
					return nil, 0, err
				}
				w += n
			default:
				if err := charge(otlpHeapPerJSONScalar); err != nil {
					return nil, 0, err
				}
				w += copy(body[w:], body[r:end])
			}
			r = end
		default:
			// A number, true, false or null: copied up to the next
			// delimiter. Anything else is left for protojson to reject.
			end := r + 1
			for end < len(body) && !isJSONDelimiter(body[end]) {
				end++
			}
			if f := top(); f != nil && f.object {
				f.idValue = false
			}
			if err := charge(otlpHeapPerJSONScalar); err != nil {
				return nil, 0, err
			}
			w += copy(body[w:], body[r:end])
			r = end
		}
	}
	if len(stack) != 0 {
		return nil, 0, fmt.Errorf("%w: unterminated object or array", errOTLPInvalidJSON)
	}
	return body[:w], heap, nil
}

// scanJSONString returns the index just past the string that opens at
// body[start], and whether it holds an escape.
func scanJSONString(body []byte, start int) (end int, escaped bool, err error) {
	for i := start + 1; i < len(body); i++ {
		switch body[i] {
		case '\\':
			escaped = true
			i++
		case '"':
			return i + 1, escaped, nil
		}
	}
	return 0, false, fmt.Errorf("%w: unterminated string", errOTLPInvalidJSON)
}

func isJSONDelimiter(c byte) bool {
	switch c {
	case ',', '}', ']', ':', ' ', '\t', '\n', '\r', '"', '{', '[':
		return true
	}
	return false
}

// hexIDToBase64InPlace writes the base64 form of the quoted hex id at
// body[r:end] to body[w:], and returns its length with the quotes. The
// id is read out before anything is written, and the base64 form of an
// id of a valid length is never longer than its hex form, so the write
// cannot overtake the walk.
func hexIDToBase64InPlace(body []byte, r, end, w int, escaped bool, scratch *[otlpTraceIDHexLen / 2]byte) (int, error) {
	hexID := body[r+1 : end-1]
	if escaped || (len(hexID) != 0 && len(hexID) != otlpSpanIDHexLen && len(hexID) != otlpTraceIDHexLen) {
		return 0, fmt.Errorf("%w: a trace or span id must be %d or %d hex characters",
			errOTLPInvalidJSON, otlpSpanIDHexLen, otlpTraceIDHexLen)
	}
	raw := scratch[:len(hexID)/2]
	if _, err := hex.Decode(raw, hexID); err != nil {
		return 0, fmt.Errorf("%w: a trace or span id is not hex", errOTLPInvalidJSON)
	}
	n := base64.StdEncoding.EncodedLen(len(raw))
	body[w] = '"'
	base64.StdEncoding.Encode(body[w+1:w+1+n], raw)
	body[w+1+n] = '"'
	return n + 2, nil
}
