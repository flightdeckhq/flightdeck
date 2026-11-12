// Package utc makes UTC the process's local time zone, by being
// imported: its init sets time.Local.
//
// The flightdeck binary needs the zone to be UTC because the query API
// formats the timestamps it reads from the database in the process's
// zone and its contract is RFC 3339 in UTC (the "Z" suffix the
// dashboard and the integration suite expect); a laptop in another zone
// would otherwise serve "+02:00" offsets. The containers the services
// ran in before had no zone, which is UTC.
//
// It is an init, not a call from main, because time.Local is a plain
// package variable that every goroutine reads (time.Now does) and
// goroutines exist before main runs: the embedded NATS server's pse
// package starts a timer in its own init that stats a file every
// second. A write from main is a data race with that timer. A write
// from this init is not: Go initialises packages in import-path order
// once their imports are initialised, this package imports only time
// and sorts before the NATS packages, so the zone is set before that
// timer, or any goroutine, is started, and everything started later is
// ordered after it. cmd/flightdeck's tests hold the binary to that
// under the race detector.
package utc

import "time"

func init() {
	time.Local = time.UTC
}
