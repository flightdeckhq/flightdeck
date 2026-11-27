//go:build scale

package storage

import (
	"log/slog"
	"os"
	"time"
)

// The scale check's build carries what the live proof of the refresh
// bound needs; every other build refreshes the statistics every
// sqliteOptimizeInterval after gathering them at start.
//
//	SCALE_OPTIMIZE_INTERVAL=20s        refresh this often (a Go duration)
//	SCALE_SKIP_START_STATISTICS=1      gather nothing at start, so the
//	                                   first refresh meets a file with
//	                                   no statistics
//
// and every refresh attempt is logged with how long it held the writer.
func init() {
	if d, err := time.ParseDuration(os.Getenv("SCALE_OPTIMIZE_INTERVAL")); err == nil && d > 0 {
		optimizeInterval = d
	}
	skipStartStatistics = os.Getenv("SCALE_SKIP_START_STATISTICS") == "1"
	observeRefresh = func(took time.Duration, interrupted bool, err error) {
		slog.Info("sqlite planner statistics refresh attempt", "held_writer", took.Round(time.Millisecond), "interrupted", interrupted, "err", err)
	}
}
