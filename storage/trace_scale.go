//go:build scale

package storage

import (
	"database/sql/driver"
	"sync/atomic"
)

// The scale check (api/internal/store/scale_test.go, built with -tags
// scale) reads the statements a dashboard request runs on SQLite, so it
// can show the query plan of each statement of a request that is over
// its budget. Only that build has SetQueryTrace; in every other build
// traceQuery is an empty function.

var queryTrace atomic.Pointer[func(query string, args []any)]

// SetQueryTrace makes every SQLite query this process runs call fn with
// its text and arguments before it runs; nil stops it. fn runs on the
// querying goroutine and must not query the database.
func SetQueryTrace(fn func(query string, args []any)) {
	if fn == nil {
		queryTrace.Store(nil)
		return
	}
	queryTrace.Store(&fn)
}

func traceQuery(query string, args []driver.NamedValue) {
	fn := queryTrace.Load()
	if fn == nil {
		return
	}
	vals := make([]any, len(args))
	for i, a := range args {
		vals[i] = a.Value
	}
	(*fn)(query, vals)
}
