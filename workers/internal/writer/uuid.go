package writer

import (
	"crypto/rand"
	"fmt"
	"strings"
)

// NewUUID returns a random version-4 UUID in canonical lower-case
// hyphenated form. The worker mints an event id itself when the client
// sent none, on both backends, so every id it writes has the one shape
// the SQLite schema's CHECK accepts and Postgres stores canonically.
func NewUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand does not fail on a supported platform; Go's own
		// documentation says a failure here is unrecoverable.
		panic(fmt.Sprintf("writer: random uuid: %v", err))
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// canonicalUUID normalises an id the worker did not mint to canonical
// lower-case hyphenated form: upper-case hex is lowered and a
// 32-digit unhyphenated id gets its hyphens. Ingestion validates the
// shape of every id it publishes, so this is defensive: a direct
// publisher on the bus could send an upper-case id that Postgres' uuid
// type would store canonically but SQLite would store as sent, and a
// later lookup by the canonical form would then miss it. Anything else
// is returned unchanged, lower-cased, for the database to refuse.
func canonicalUUID(id string) string {
	id = strings.ToLower(id)
	if len(id) == 32 && !strings.Contains(id, "-") {
		return id[0:8] + "-" + id[8:12] + "-" + id[12:16] + "-" + id[16:20] + "-" + id[20:]
	}
	return id
}

// nullIfEmpty binds an optional id or text as NULL when empty, so the
// shared SQL needs no cast: on Postgres a NULL or text argument takes
// the column's type, where NULLIF($n, ”) would be text and fail
// against a uuid column.
func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// jsonArg binds a JSON document as text, or NULL when there is none.
// SQLite binds []byte as a BLOB, which the json_valid CHECKs refuse;
// Postgres takes text for a jsonb parameter.
func jsonArg(b []byte) any {
	if b == nil {
		return nil
	}
	return string(b)
}
