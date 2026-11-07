// Package logcap bounds the payload strings the worker writes to its
// log lines.
//
// Every event reaches the worker through NATS, which the worker treats
// as untrusted: a publisher that skips the ingestion API can put any
// string of up to the NATS payload limit (1 MiB) in any field. A field
// logged verbatim would then turn one hostile event into a megabyte log
// line. Each value a log line takes from a payload, or from an error
// that may quote one, goes through the cap for its kind below.
//
// A capped value keeps its leading bytes, cut on a UTF-8 boundary so the
// log line stays valid text, and ends with its full length in bytes, so
// an operator sees both what the value started with and how large it
// was. Only ids, names and error text are ever logged; prompt content
// never is, capped or not.
package logcap

import (
	"fmt"
	"unicode/utf8"
)

const (
	// MaxID caps an identifier (an event id, an agent id, a session or
	// parent session id). A canonical UUID is 36 bytes, so every
	// well-formed id is logged whole, and 64 bytes of a malformed one is
	// enough to recognise its shape (a quoted string, a JSON fragment, a
	// UUID with extra text).
	MaxID = 64

	// MaxEventType caps an event type. The longest type in the
	// vocabulary is 26 bytes (mcp_policy_user_remembered); 64 leaves
	// room for new ones without a change here.
	MaxEventType = 64

	// MaxTimestamp caps a raw timestamp the worker could not parse. An
	// RFC 3339 timestamp with nanoseconds and a zone offset is 35 bytes.
	MaxTimestamp = 64

	// MaxName caps a free-form name (a flavor, an MCP server name, a
	// policy scope value). 256 bytes is the cap the ingestion API puts
	// on the names it validates (agent_role, the MCP server fields).
	MaxName = 256

	// MaxErr caps error text and a recovered panic's value. Postgres
	// quotes the offending input in a cast error ("invalid input syntax
	// for type uuid: ..."), so an error can carry a payload value; 1 KiB
	// keeps the whole of every error the worker produces on well-formed
	// input (SQLSTATE, message, constraint or column name) readable.
	MaxErr = 1024
)

// Cap returns s unchanged when it is at most limit bytes, and otherwise
// its first limit bytes, cut back to a UTF-8 boundary, followed by its
// full length. A limit below one keeps no leading bytes.
func Cap(s string, limit int) string {
	if len(s) <= limit {
		return s
	}
	cut := max(limit, 0)
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return fmt.Sprintf("%s…(%d bytes)", s[:cut], len(s))
}

// ID caps an identifier at MaxID.
func ID(s string) string { return Cap(s, MaxID) }

// EventType caps an event type at MaxEventType.
func EventType(s string) string { return Cap(s, MaxEventType) }

// Timestamp caps a raw timestamp at MaxTimestamp.
func Timestamp(s string) string { return Cap(s, MaxTimestamp) }

// Name caps a free-form name at MaxName.
func Name(s string) string { return Cap(s, MaxName) }

// Err renders err's text capped at MaxErr; a nil error renders as
// "<nil>", as slog would print it.
func Err(err error) string {
	if err == nil {
		return "<nil>"
	}
	return Cap(err.Error(), MaxErr)
}

// Value renders an arbitrary value (a recovered panic's) capped at
// MaxErr.
func Value(v any) string {
	return Cap(fmt.Sprint(v), MaxErr)
}
