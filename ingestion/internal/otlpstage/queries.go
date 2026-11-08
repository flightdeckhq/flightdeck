package otlpstage

import (
	"context"
	"database/sql"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// queries is the SQL that differs between the backends, chosen once
// per Store. Every query takes the arguments its field comment lists,
// in that order; the common statements live beside their callers in
// store.go.
type queries struct {
	// existingRecords reads the (span_id, kind) of the staged records
	// among the given keys: $1 token_key, $2 trace_id, $3 and $4 the
	// key arguments keyArgs builds.
	existingRecords string
	// claimDue leases the due traces: $1 owner, $2 now, $3 the lease's
	// expiry, $4 the batch size; it returns traceColumns.
	claimDue string
	// deferTrace releases a lease and moves the timer: $1 token_key,
	// $2 trace_id, $3 owner, $4 now, $5 the gen the caller decided on,
	// $6 the deferral, $7 MaxTraceHold in seconds.
	deferTrace string
	// markRecords marks the given records assembled: $1 token_key, $2
	// trace_id, $3 and $4 the key arguments, $5 the assembly number.
	markRecords string
	// deleteContent deletes the given records' content: $1 token_key,
	// $2 trace_id, $3 and $4 the key arguments.
	deleteContent string
	// sweepTraces deletes one batch of traces past their retention: $1
	// the complete cutoff, $2 the degraded cutoff, $3 the batch size,
	// $4 the complete reason.
	sweepTraces string
	// sweepContent deletes one batch of content past the backstop age:
	// $1 the cutoff, $2 the batch size.
	sweepContent string

	// keyArgs renders a list of record keys as the two arguments the
	// IN-list statements above take.
	keyArgs func(ids [][]byte, kinds []int16) (idsArg, kindsArg any)
	// insertFacts stages records and returns the ones it inserted, so
	// their content and the root check never act on a row it did not
	// write.
	insertFacts func(ctx context.Context, tx *sql.Tx, key TraceKey, records []Record, now time.Time) ([]Record, error)
	// insertContent stages the content of the given (new) records whose
	// own resource declares capture. The caller has checked the trace's
	// posture.
	insertContent func(ctx context.Context, tx *sql.Tx, key TraceKey, records []Record, now time.Time) error
}

// queriesFor returns the query set of db's backend.
func queriesFor(db *storage.DB) queries {
	if db.Backend == storage.Postgres {
		return postgresQueries(db.Dialect)
	}
	return sqliteQueries(db.Dialect)
}
