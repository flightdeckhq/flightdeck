package storage

import (
	"context"
	"database/sql"
	"errors"
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
// analyzed and those whose size has changed tenfold since. The mask
// 0x10002 makes it look at every table, not only the ones the
// connection itself has queried: the dashboard's queries run on the read
// pools, never on the writer that analyzes. ANALYZE samples each index
// (sqliteAnalysisLimit) but still reads every page of the table and its
// indexes to count their rows, so its time grows with the table and
// with how little of it the page cache holds: on 1,000,000 events about
// 0.15 s warm and 13.7 s from a cold file (measured).
//
// A connection reads the statistics when it loads the schema, and an
// open connection does not see an ANALYZE another one ran (measured: a
// read connection kept its plan, a new one took the session index). So
// a process gathers them once at start with GatherStatistics, after
// its migrations and before it shares the handle, taking as long as it
// takes (nothing writes yet); the writer then refreshes them every
// sqliteOptimizeInterval in attempts that never hold it longer than
// sqliteOptimizeBound; and a read connection is replaced after
// sqliteReaderMaxLifetime, so one opened before an ANALYZE uses the new
// statistics within that time.
const (
	// sqliteOptimizePragma analyzes the tables that need it, all of
	// them considered.
	sqliteOptimizePragma = "PRAGMA optimize=0x10002"
	// sqliteStatisticsTimeout bounds the gathering at start. A start
	// waits for it, so it stays inside the 60 s a container is given
	// to answer its health check with the rest of the start: a cold
	// file of 1,000,000 events takes 13.7 s (measured); a larger cold
	// one is interrupted here and left to the bounded refreshes below.
	sqliteStatisticsTimeout = 30 * time.Second
	// sqliteOptimizeInterval is how often the writer looks again once
	// the statistics are current. When no table has changed tenfold the
	// pragma reads nothing and takes about 0.1 ms (measured on 100,000
	// and 1,000,000 events). The events table of a production agent can
	// grow tenfold in days, so an hour keeps a plan from being chosen on
	// statistics older than an hour plus a reader's lifetime; SQLite's
	// advice for long-lived connections is hourly to daily.
	sqliteOptimizeInterval = time.Hour
	// sqliteOptimizeBound is the longest one refresh may hold the
	// writer while the process serves; the statement is interrupted at
	// it. Every write waits behind it, and the tightest wait among them
	// is the OTLP staging write's 2 s statement timeout, which also
	// covers its own transaction; 750 ms leaves that write more than a
	// second of its own. A warm refresh of 1,000,000 events takes about
	// 0.15 s, well inside it.
	sqliteOptimizeBound = 750 * time.Millisecond
	// sqliteOptimizeRetryPause is the pause after an interrupted
	// refresh. The interrupted attempt has pulled pages into the cache,
	// so the next one gets further; the pause lets the writes that
	// queued behind it through first, and two seconds of writes at
	// any realistic rate drain in a fraction of that.
	sqliteOptimizeRetryPause = 2 * time.Second
	// sqliteOptimizeRetries is how many interrupted refreshes in a row
	// are tried before waiting the full interval again: thirty
	// attempts read 22 s of pages at most, more than a cold file of
	// 1,000,000 events needs (measured: it completed within that
	// budget), and a table too large for that is analyzed at the next
	// start, which has no bound.
	sqliteOptimizeRetries = 30
	// sqliteOptimizeSlowLog is how long a refresh may take before it is
	// logged at info level: a second is far past a warm one (0.1 ms
	// with nothing to do, about 0.15 s with 1,000,000 events), so the
	// log shows only the refreshes that read from disk.
	sqliteOptimizeSlowLog = time.Second
	// sqliteAnalysisLimit bounds the rows ANALYZE reads of each index
	// (PRAGMA analysis_limit, set on the writer's connection). The
	// sample caps the rows per value of an unselective index near the
	// limit (events_type_idx reads 1,001 instead of 76,947) but keeps
	// the order of the indexes by selectivity, which is what decides
	// the plans (the scale check ran with it); unsampled, a warm
	// analysis of 1,000,000 events took 1.42 s instead of 0.15 s.
	// SQLite recommends 100 to 1000.
	sqliteAnalysisLimit = 1000
	// sqliteReaderMaxLifetime is how long a read connection is kept
	// before it is replaced; see above. Reopening costs about a
	// millisecond, once an hour per connection.
	sqliteReaderMaxLifetime = time.Hour
)

// GatherStatistics brings the planner statistics of a SQLite database up
// to date and returns how long it took. A process calls it once at
// start, after its migrations, so an index a migration created is
// analyzed, and before it shares the handle, so every read connection
// it opens afterwards plans with them; the read connections already
// open are closed once idle and reopen with them. It is not bounded by
// sqliteOptimizeBound, since nothing writes yet, only by
// sqliteStatisticsTimeout: on a cold file of 1,000,000 events it takes
// about 14 s. On Postgres, and on a shared handle, it does nothing.
func (db *DB) GatherStatistics(ctx context.Context) (time.Duration, error) {
	if db.Backend != SQLite || db.shared || skipStartStatistics {
		return 0, nil
	}
	ctx, cancel := context.WithTimeout(ctx, sqliteStatisticsTimeout)
	defer cancel()
	start := time.Now()
	_, err := db.ExecContext(ctx, sqliteOptimizePragma)
	took := time.Since(start)
	db.reader.SetMaxIdleConns(0)
	db.reader.SetMaxIdleConns(sqliteReaderConns)
	if err != nil {
		return took, fmt.Errorf("storage: gather planner statistics: %w", err)
	}
	return took, nil
}

// optimizeInterval is sqliteOptimizeInterval, except in the scale
// check's build, where the live proof of the bound shortens it
// (optimize_scale.go).
var optimizeInterval = sqliteOptimizeInterval

// skipStartStatistics and observeRefresh are the scale check's hooks
// (optimize_scale.go): the live proof of the bound skips the gathering
// at start, so the first refresh meets a file with no statistics, and
// logs every refresh attempt. Outside that build they are unset.
var (
	skipStartStatistics bool
	observeRefresh      func(took time.Duration, interrupted bool, err error)
)

// sqliteOptimizer refreshes the planner statistics on the writer while
// the process serves, every interval, each attempt interrupted after
// bound and retried after pause up to retries times in a row.
type sqliteOptimizer struct {
	writer   *sql.DB
	interval time.Duration
	bound    time.Duration
	pause    time.Duration
	retries  int
	// observe, when set (tests), is told the outcome of every attempt.
	observe func(took time.Duration, interrupted bool, err error)

	stop chan struct{}
	done chan struct{}
	once sync.Once
}

func startSQLiteOptimizer(writer *sql.DB) *sqliteOptimizer {
	return startSQLiteOptimizerWith(&sqliteOptimizer{
		writer: writer, interval: optimizeInterval, bound: sqliteOptimizeBound,
		pause: sqliteOptimizeRetryPause, retries: sqliteOptimizeRetries, observe: observeRefresh,
	})
}

func startSQLiteOptimizerWith(o *sqliteOptimizer) *sqliteOptimizer {
	o.stop = make(chan struct{})
	o.done = make(chan struct{})
	go o.run()
	return o
}

// Stop ends the loop and waits for an attempt in progress, which is
// interrupted.
func (o *sqliteOptimizer) Stop() {
	o.once.Do(func() { close(o.stop) })
	<-o.done
}

// attempt runs the pragma once, interrupted after bound. interrupted
// reports that the bound cut it short.
func (o *sqliteOptimizer) attempt(ctx context.Context) (took time.Duration, interrupted bool, err error) {
	actx, cancel := context.WithTimeout(ctx, o.bound)
	defer cancel()
	start := time.Now()
	_, err = o.writer.ExecContext(actx, sqliteOptimizePragma)
	took = time.Since(start)
	if err != nil && ctx.Err() == nil && errors.Is(actx.Err(), context.DeadlineExceeded) {
		return took, true, nil
	}
	return took, false, err
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
	timer := time.NewTimer(o.interval)
	defer timer.Stop()
	interrupted := 0
	for {
		select {
		case <-o.stop:
			return
		case <-timer.C:
		}
		took, cut, err := o.attempt(ctx)
		if ctx.Err() != nil {
			return
		}
		if o.observe != nil {
			o.observe(took, cut, err)
		}
		next := o.interval
		switch {
		case cut && interrupted+1 < o.retries:
			interrupted++
			next = o.pause
		case cut:
			slog.Warn("sqlite planner statistics not refreshed: every attempt was interrupted at its bound; the next start gathers them without it",
				"attempts", interrupted+1, "bound", o.bound, "next_attempt_in", o.interval)
			interrupted = 0
		case err != nil:
			slog.Warn("sqlite planner statistics not refreshed", "err", err)
			interrupted = 0
		default:
			if interrupted > 0 || took > sqliteOptimizeSlowLog {
				slog.Info("sqlite planner statistics refreshed", "attempts", interrupted+1, "took", took.Round(time.Millisecond))
			}
			interrupted = 0
		}
		timer.Reset(next)
	}
}
