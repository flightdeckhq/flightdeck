package storage

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// Planner statistics.
//
// SQLite's query planner chooses among a table's indexes by the
// statistics ANALYZE keeps in sqlite_stat1. With none it rates every
// index that matches an equality alike, and on events that choice is
// costly: a run's close reasons (session_id = ? AND event_type =
// 'session_end') were read through the event_type index, every
// session_end of the fleet once for each run a page lists, instead of
// through the session index and the run's own events (2.4 s against
// 13 ms for the Fleet page's 248 runs at 100,000 events, measured).
//
// PRAGMA optimize runs ANALYZE on the tables that need it: those never
// analyzed and those whose size has changed tenfold since, each index
// sampled (sqliteAnalysisLimit) rather than read whole. The mask 0x10002 makes it look at every
// table, not only the ones the connection itself has queried: the
// dashboard's queries run on the read pools, never on the writer that
// analyzes.
//
// A connection reads the statistics when it loads the schema, and an
// open connection does not see an ANALYZE another one ran (measured: a
// read connection kept its plan, a new one took the session index). So
// the writer runs the pragma when the database opens, before any read
// connection is made, and again every sqliteOptimizeInterval; and a
// read connection is replaced after sqliteReaderMaxLifetime, so one
// opened before an ANALYZE uses the new statistics within that time.
const (
	// sqliteOptimizePragma analyzes the tables that need it, all of
	// them considered.
	sqliteOptimizePragma = "PRAGMA optimize=0x10002"
	// sqliteOptimizeInterval is how often the writer runs the pragma
	// after the first time. When no table has changed tenfold it reads
	// nothing and takes about 0.1 ms (measured on 100,000 and on
	// 1,000,000 events); when one has, the sampled ANALYZE holds the
	// writer for about 150 ms on 1,000,000 events (measured, with
	// sqliteAnalysisLimit). The events table of a production agent can
	// grow tenfold in days, so an hour keeps a plan from being chosen on
	// statistics older than an hour plus a reader's lifetime, at no
	// cost the rest of the time; SQLite's own advice for long-lived
	// connections is hourly to daily.
	sqliteOptimizeInterval = time.Hour
	// sqliteOptimizeTimeout bounds one run, so a pragma that waits
	// (behind a long write transaction) gives the writer back instead
	// of queueing every write behind it.
	sqliteOptimizeTimeout = time.Minute
	// sqliteAnalysisLimit bounds the rows ANALYZE reads of each index
	// (PRAGMA analysis_limit, set on the writer's connection), so the
	// statistics are a sample and the time the pragma holds the writer
	// does not grow with the table: the first analysis of 1,000,000
	// events took 1.42 s unbounded and 147 ms at this limit (measured).
	// The sample caps the rows per value of an unselective index near
	// the limit (events_type_idx reads 1,001 instead of 76,947) but
	// keeps the order of the indexes by selectivity, which is what
	// decides the plans (the scale check ran with it). SQLite
	// recommends 100 to 1000.
	sqliteAnalysisLimit = 1000
	// sqliteReaderMaxLifetime is how long a read connection is kept
	// before it is replaced; see above. Reopening costs about a
	// millisecond, once an hour per connection.
	sqliteReaderMaxLifetime = time.Hour
)

// optimizeSQLite runs the optimize pragma once on the writer's
// connection. Writes queue behind it.
func optimizeSQLite(ctx context.Context, writer *sql.DB) error {
	ctx, cancel := context.WithTimeout(ctx, sqliteOptimizeTimeout)
	defer cancel()
	if _, err := writer.ExecContext(ctx, sqliteOptimizePragma); err != nil {
		return fmt.Errorf("storage: %s: %w", sqliteOptimizePragma, err)
	}
	return nil
}

// sqliteOptimizer runs the optimize pragma on the writer every
// interval until Stop.
type sqliteOptimizer struct {
	writer   *sql.DB
	interval time.Duration
	stop     chan struct{}
	done     chan struct{}
	once     sync.Once
}

func startSQLiteOptimizer(writer *sql.DB, interval time.Duration) *sqliteOptimizer {
	o := &sqliteOptimizer{writer: writer, interval: interval, stop: make(chan struct{}), done: make(chan struct{})}
	go o.run()
	return o
}

// Stop ends the loop and waits for a run in progress.
func (o *sqliteOptimizer) Stop() {
	o.once.Do(func() { close(o.stop) })
	<-o.done
}

func (o *sqliteOptimizer) run() {
	defer close(o.done)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-o.stop:
			cancel()
		case <-ctx.Done():
		}
	}()
	ticker := time.NewTicker(o.interval)
	defer ticker.Stop()
	for {
		select {
		case <-o.stop:
			return
		case <-ticker.C:
		}
		start := time.Now()
		if err := optimizeSQLite(ctx, o.writer); err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Warn("sqlite planner statistics not refreshed", "err", err)
			continue
		}
		if took := time.Since(start); took > time.Second {
			slog.Info("sqlite planner statistics refreshed", "took", took.Round(time.Millisecond))
		}
	}
}
