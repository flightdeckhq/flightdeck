//go:build !scale

package storage

import "database/sql/driver"

// traceQuery hands a SQLite query to the scale check's trace
// (trace_scale.go); outside that build it does nothing and is inlined
// away.
func traceQuery(string, []driver.NamedValue) {}
