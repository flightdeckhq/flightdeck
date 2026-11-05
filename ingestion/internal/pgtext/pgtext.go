// Package pgtext makes text and JSON Postgres can store, and describes a
// database error without its data. Postgres text cannot hold U+0000, and
// jsonb refuses the \u0000 escape and an unpaired UTF-16 surrogate escape
// (\ud800 alone), all of which are valid JSON and valid Go strings. One
// such character in a staged record or an event would fail the write of
// the whole request or event on every retry, so ingestion replaces each
// with U+FFFD, the replacement character, before anything is staged or
// published.
package pgtext

import (
	"bytes"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
)

// replacement is U+FFFD as a JSON escape: the same six bytes as the
// escape it replaces, so a replaced document keeps its length.
const replacement = `\ufffd`

// String is s with every U+0000 replaced by U+FFFD.
func String(s string) string {
	if strings.IndexByte(s, 0) < 0 {
		return s
	}
	return strings.ReplaceAll(s, "\x00", "\ufffd")
}

// JSON is a JSON document with every \u0000 escape, and every \u escape
// of a UTF-16 surrogate not paired with its other half, replaced by
// \ufffd. Only escapes are rewritten: an escaped backslash followed by
// the text u0000 is left as it is, and the length never changes. A
// document with nothing to replace is returned as it is.
func JSON(raw []byte) []byte {
	if bytes.IndexByte(raw, '\\') < 0 {
		return raw
	}
	var out []byte // allocated on the first replacement
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' || i+1 >= len(raw) {
			continue
		}
		if raw[i+1] != 'u' {
			i++ // a two-byte escape, \\ included
			continue
		}
		r, ok := hex4(raw, i+2)
		if !ok {
			i++
			continue
		}
		width := 6
		bad := false
		switch {
		case r == 0:
			bad = true
		case r >= 0xD800 && r <= 0xDBFF:
			// A high surrogate must be followed by an escaped low one.
			if low, ok := lowAt(raw, i+6); ok && low >= 0xDC00 && low <= 0xDFFF {
				width = 12
			} else {
				bad = true
			}
		case r >= 0xDC00 && r <= 0xDFFF:
			bad = true // a low surrogate with no high one before it
		}
		if bad {
			if out == nil {
				out = bytes.Clone(raw)
			}
			copy(out[i:i+6], replacement)
		}
		i += width - 1
	}
	if out == nil {
		return raw
	}
	return out
}

// lowAt reads a \uXXXX escape starting at i.
func lowAt(raw []byte, i int) (rune, bool) {
	if i+1 >= len(raw) || raw[i] != '\\' || raw[i+1] != 'u' {
		return 0, false
	}
	return hex4(raw, i+2)
}

func hex4(raw []byte, i int) (rune, bool) {
	if i+4 > len(raw) {
		return 0, false
	}
	var r rune
	for _, c := range raw[i : i+4] {
		var d byte
		switch {
		case c >= '0' && c <= '9':
			d = c - '0'
		case c >= 'a' && c <= 'f':
			d = c - 'a' + 10
		case c >= 'A' && c <= 'F':
			d = c - 'A' + 10
		default:
			return 0, false
		}
		r = r<<4 | rune(d)
	}
	return r, true
}

// ErrorClass describes a database error for a log line without any of
// the data it was about: a Postgres error by its SQLSTATE code and the
// table and constraint it names, never its message, detail or context
// (which quote the rejected value), after the text of the layers that
// wrapped it; any other error (a timeout, a lost connection), which
// carries no data, as it is.
func ErrorClass(err error) string {
	if err == nil {
		return ""
	}
	var pgErr *pgconn.PgError
	if !errors.As(err, &pgErr) {
		return err.Error()
	}
	prefix := strings.TrimSuffix(err.Error(), pgErr.Error())
	class := prefix + "postgres error SQLSTATE " + pgErr.Code
	if pgErr.TableName != "" {
		class += " table " + pgErr.TableName
	}
	if pgErr.ConstraintName != "" {
		class += " constraint " + pgErr.ConstraintName
	}
	return class
}
