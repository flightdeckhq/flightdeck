package handlers

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
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

// otlpJSONUnmarshal ignores fields it does not know: OTLP receivers
// must accept requests from exporters built against a newer proto.
var otlpJSONUnmarshal = protojson.UnmarshalOptions{DiscardUnknown: true}

// unmarshalOTLPJSON decodes an OTLP JSON request body into msg. OTLP
// JSON is protojson with two differences: trace and span ids are hex,
// not base64, and enums may be integers (protojson accepts those as
// is). The ids are re-encoded as base64 before protojson reads the
// body.
func unmarshalOTLPJSON(body []byte, msg proto.Message) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	// Numbers stay as written: int64 timestamps and counters lose
	// precision as float64.
	dec.UseNumber()
	var tree any
	if err := dec.Decode(&tree); err != nil {
		return fmt.Errorf("invalid JSON: %w", err)
	}
	if dec.More() {
		return fmt.Errorf("invalid JSON: trailing data after the request object")
	}
	if err := hexIDsToBase64(tree); err != nil {
		return err
	}
	converted, err := json.Marshal(tree)
	if err != nil {
		return fmt.Errorf("re-encode OTLP JSON: %w", err)
	}
	if err := otlpJSONUnmarshal.Unmarshal(converted, msg); err != nil {
		return fmt.Errorf("invalid OTLP JSON: %w", err)
	}
	return nil
}

// hexIDsToBase64 walks a decoded JSON tree and rewrites every hex id
// field in place as base64.
func hexIDsToBase64(node any) error {
	switch v := node.(type) {
	case map[string]any:
		for key, child := range v {
			if s, ok := child.(string); ok && otlpHexIDFields[key] {
				raw, err := hex.DecodeString(s)
				if err != nil {
					return fmt.Errorf("invalid OTLP JSON: %s is not hex", key)
				}
				v[key] = base64.StdEncoding.EncodeToString(raw)
				continue
			}
			if err := hexIDsToBase64(child); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range v {
			if err := hexIDsToBase64(child); err != nil {
				return err
			}
		}
	}
	return nil
}
