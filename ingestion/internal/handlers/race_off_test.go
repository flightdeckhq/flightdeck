//go:build !race

package handlers

// raceEnabled reports a -race build, whose instrumentation changes what
// allocations cost; the tests that measure allocation skip under it.
const raceEnabled = false
