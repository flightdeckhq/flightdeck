package handlers

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
)

// otlpAttrs is a record's or a resource's attributes by key. A key sent
// twice keeps its first value.
type otlpAttrs map[string]*commonpb.AnyValue

func newOTLPAttrs(kvs []*commonpb.KeyValue) otlpAttrs {
	out := make(otlpAttrs, len(kvs))
	for _, kv := range kvs {
		if _, seen := out[kv.GetKey()]; !seen {
			out[kv.GetKey()] = kv.GetValue()
		}
	}
	return out
}

// str is the attribute as a string whatever its OTLP type: an
// exporter may send a number or a boolean as a string and a string
// field as a number. A missing attribute, an array, a map or bytes is
// "" and false.
func (a otlpAttrs) str(key string) (string, bool) {
	v, ok := a[key]
	if !ok || v == nil {
		return "", false
	}
	switch x := v.GetValue().(type) {
	case *commonpb.AnyValue_StringValue:
		return x.StringValue, true
	case *commonpb.AnyValue_IntValue:
		return strconv.FormatInt(x.IntValue, 10), true
	case *commonpb.AnyValue_DoubleValue:
		return strconv.FormatFloat(x.DoubleValue, 'f', -1, 64), true
	case *commonpb.AnyValue_BoolValue:
		return strconv.FormatBool(x.BoolValue), true
	}
	return "", false
}

// text is a non-empty string attribute, "" when absent or empty.
func (a otlpAttrs) text(key string) string {
	s, _ := a.str(key)
	return s
}

// integer is the attribute as an int64: an int, a double holding a
// whole number, or a string of either ("409", "409.0"). present is
// false when the attribute is missing; ok is false when it is present
// but not a whole number.
func (a otlpAttrs) integer(key string) (n int64, present, ok bool) {
	v, has := a[key]
	if !has || v == nil {
		return 0, false, false
	}
	switch x := v.GetValue().(type) {
	case *commonpb.AnyValue_IntValue:
		return x.IntValue, true, true
	case *commonpb.AnyValue_DoubleValue:
		return wholeNumber(x.DoubleValue)
	case *commonpb.AnyValue_StringValue:
		s := strings.TrimSpace(x.StringValue)
		if i, err := strconv.ParseInt(s, 10, 64); err == nil {
			return i, true, true
		}
		if f, err := strconv.ParseFloat(s, 64); err == nil {
			return wholeNumber(f)
		}
		return 0, true, false
	}
	return 0, true, false
}

// maxWholeNumber is the largest whole number a double holds exactly
// (2^53); a larger one cannot be told from its neighbours.
const maxWholeNumber = 1 << 53

func wholeNumber(f float64) (int64, bool, bool) {
	if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) || math.Abs(f) > maxWholeNumber {
		return 0, true, false
	}
	return int64(f), true, true
}

// number is the attribute as a float64: an int, a double or a numeric
// string. present and ok as for integer.
func (a otlpAttrs) number(key string) (f float64, present, ok bool) {
	v, has := a[key]
	if !has || v == nil {
		return 0, false, false
	}
	switch x := v.GetValue().(type) {
	case *commonpb.AnyValue_IntValue:
		return float64(x.IntValue), true, true
	case *commonpb.AnyValue_DoubleValue:
		f = x.DoubleValue
	case *commonpb.AnyValue_StringValue:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(x.StringValue), 64)
		if err != nil {
			return 0, true, false
		}
		f = parsed
	default:
		return 0, true, false
	}
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0, true, false
	}
	return f, true, true
}

// boolean is the attribute as a bool: a bool, or the string "true" or
// "false" in any case. present and ok as for integer.
func (a otlpAttrs) boolean(key string) (b, present, ok bool) {
	v, has := a[key]
	if !has || v == nil {
		return false, false, false
	}
	switch x := v.GetValue().(type) {
	case *commonpb.AnyValue_BoolValue:
		return x.BoolValue, true, true
	case *commonpb.AnyValue_StringValue:
		switch strings.ToLower(strings.TrimSpace(x.StringValue)) {
		case "true":
			return true, true, true
		case "false":
			return false, true, true
		}
	}
	return false, true, false
}

// otlpRedacted is what Claude Code sends in place of a prompt or a
// response it was told not to log.
const otlpRedacted = "<REDACTED>"

// content is a content attribute (a prompt, a tool input, error text)
// when it carries content: a non-empty string other than the
// redaction placeholder.
func (a otlpAttrs) content(key string) (string, bool) {
	v, has := a[key]
	if !has || v == nil {
		return "", false
	}
	s, isStr := v.GetValue().(*commonpb.AnyValue_StringValue)
	if !isStr || s.StringValue == "" || strings.TrimSpace(s.StringValue) == otlpRedacted {
		return "", false
	}
	return s.StringValue, true
}

// Bounds on the reasons a partial_success message names for the log
// records a dialect did not use, the same bounds as the sources it
// names: at most maxEchoedOTLPSources reasons, each cut to
// maxEchoedOTLPSourceBytes, out of at most maxTrackedOTLPSources
// distinct reasons tracked per request.

// rejectionSet counts the records a dialect did not use, by reason.
type rejectionSet struct {
	counts   map[string]int64
	untraced int64 // records whose reason was past the tracked bound
	total    int64
}

func newRejectionSet() *rejectionSet {
	return &rejectionSet{counts: map[string]int64{}}
}

// add counts n records not used for reason. The reason is cut to the
// echoed bound first, so two reasons that differ only past it count
// as one.
func (r *rejectionSet) add(reason string, n int64) {
	if n <= 0 {
		return
	}
	r.total += n
	reason = truncateUTF8(reason, maxEchoedOTLPSourceBytes)
	if _, ok := r.counts[reason]; !ok && len(r.counts) == maxTrackedOTLPSources {
		r.untraced += n
		return
	}
	r.counts[reason] += n
}

// message is the partial_success message for the counted records, such
// as `3 log records not used: "claude_code.assistant_response" is not
// mapped (2); "claude_code.tool_decision" other than a reject is not
// mapped (1)`, the most frequent reasons first; "" when none.
func (r *rejectionSet) message(record string) string {
	if r.total == 0 {
		return ""
	}
	if r.total != 1 {
		record += "s"
	}
	reasons := make([]string, 0, len(r.counts))
	for reason := range r.counts {
		reasons = append(reasons, reason)
	}
	sort.Slice(reasons, func(i, j int) bool {
		if r.counts[reasons[i]] != r.counts[reasons[j]] {
			return r.counts[reasons[i]] > r.counts[reasons[j]]
		}
		return reasons[i] < reasons[j]
	})
	shown := reasons[:min(len(reasons), maxEchoedOTLPSources)]
	parts := make([]string, len(shown))
	for i, reason := range shown {
		parts[i] = fmt.Sprintf("%s (%d)", reason, r.counts[reason])
	}
	out := fmt.Sprintf("%d %s not used: %s", r.total, record, strings.Join(parts, "; "))
	var rest int64
	for _, reason := range reasons[len(shown):] {
		rest += r.counts[reason]
	}
	rest += r.untraced
	if rest > 0 {
		out += fmt.Sprintf("; %d for other reasons", rest)
	}
	return out
}
