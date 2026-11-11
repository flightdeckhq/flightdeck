package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"sync"
	"time"
)

// The write-ahead log and its reset.
//
// SQLite appends every write to the write-ahead log (<file>-wal) and
// copies it into the database file at a checkpoint. Its automatic
// checkpoint runs on the writer every 1000 pages and never waits: it
// copies what no reader still needs and leaves the rest. The log file
// itself is only started over when a checkpoint has copied everything
// and no reader is reading from the log, and with readers that overlap
// without a gap (a dashboard polling while events arrive) that moment
// never comes by itself: the log then grows without bound (446 MiB for
// 10,000 events under eight readers, measured), and every read and
// write slows down with it.
//
// So the writer also runs a TRUNCATE checkpoint whenever the log has
// outgrown sqliteCheckpointWALBytes. That checkpoint does wait: for the
// write in progress, then for the readers that still use the log (new
// readers no longer do, once everything is copied), for at most
// sqliteCheckpointBusyTimeoutMillis; then the log is emptied. Writes
// queue behind it on the one writer connection; reads are never held.
// When a long read keeps it from finishing in time it gives up, the
// writes go on, and it tries again after a pause that doubles with
// each attempt in a row that was kept out, so a read that runs for a
// minute costs the writers a few waits, not one every second.
const (
	// sqliteCheckpointInterval is how often the log's size is looked
	// at. A second keeps the log within a few seconds' worth of writes
	// of the threshold; the look itself is one stat call.
	sqliteCheckpointInterval = time.Second
	// sqliteCheckpointWALBytes is the log size above which the writer
	// resets it. SQLite's own checkpoint keeps a log that is being
	// reset at about 4 MiB (1000 pages of 4 KiB), so four times that
	// means the automatic reset is not happening.
	sqliteCheckpointWALBytes = 16 << 20
	// sqliteCheckpointBusyTimeoutMillis is how long the checkpoint
	// waits for the reads in flight to end, during which writes queue.
	// It has to outlast them to succeed: under eight readers in a
	// tight loop the listing queries took up to 400 ms (measured), and
	// with a quarter-second wait most attempts were kept out, each one
	// holding the writers for nothing while the log grew to 124 MiB.
	// A second covers those reads; a read that runs longer (analytics
	// over a large window) postpones the reset.
	sqliteCheckpointBusyTimeoutMillis = 1000
	// sqliteCheckpointMaxBackoff caps the pause between attempts that
	// were kept out. Half a minute keeps the writers' cost under a
	// long read to one wait in thirty seconds while still resetting
	// the log soon after the read ends.
	sqliteCheckpointMaxBackoff = 30 * time.Second
	// sqliteCheckpointWarnAfter is how many attempts in a row may fail
	// to reset the log before a warning names its size. With the
	// doubling pause that is several minutes of a log that only grows:
	// a reader is stuck, or reads never leave a one-second gap.
	sqliteCheckpointWarnAfter = 10
)

// walCheckpointer resets a SQLite database's write-ahead log from the
// writer handle; see the comment above.
type walCheckpointer struct {
	writer  *sql.DB
	walPath string
	stop    chan struct{}
	done    chan struct{}
	once    sync.Once
}

// startWALCheckpointer runs the checkpointer until its Stop.
func startWALCheckpointer(writer *sql.DB, dbPath string) *walCheckpointer {
	c := &walCheckpointer{
		writer:  writer,
		walPath: dbPath + "-wal",
		stop:    make(chan struct{}),
		done:    make(chan struct{}),
	}
	go c.run()
	return c
}

// Stop ends the loop and waits for a checkpoint in progress.
func (c *walCheckpointer) Stop() {
	c.once.Do(func() { close(c.stop) })
	<-c.done
}

func (c *walCheckpointer) run() {
	defer close(c.done)
	ticker := time.NewTicker(sqliteCheckpointInterval)
	defer ticker.Stop()
	// A checkpoint ends with the loop: the context is cancelled on Stop.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-c.stop:
			cancel()
		case <-ctx.Done():
		}
	}()

	// failures counts the attempts in a row that did not reset a log
	// over the threshold; notBefore is when the next one may run.
	failures := 0
	var notBefore time.Time
	for {
		select {
		case <-c.stop:
			return
		case now := <-ticker.C:
			if now.Before(notBefore) {
				continue
			}
		}
		reset, err := c.checkpoint(ctx)
		if ctx.Err() != nil {
			return
		}
		if err == nil && (reset || c.walSize() <= sqliteCheckpointWALBytes) {
			failures = 0
			notBefore = time.Time{}
			continue
		}
		failures++
		notBefore = time.Now().Add(checkpointBackoff(failures))
		if failures%sqliteCheckpointWarnAfter != 0 {
			continue
		}
		if err != nil {
			slog.Warn("sqlite write-ahead log checkpoint failed", "attempts", failures, "err", err)
		} else {
			slog.Warn("sqlite write-ahead log is not being reset: a read was in progress at every attempt",
				"attempts", failures, "wal_bytes", c.walSize())
		}
	}
}

// checkpointBackoff is the pause after the given number of attempts in
// a row that did not reset the log: the interval, doubling, capped.
func checkpointBackoff(failures int) time.Duration {
	d := sqliteCheckpointInterval
	for i := 1; i < failures && d < sqliteCheckpointMaxBackoff; i++ {
		d *= 2
	}
	return min(d, sqliteCheckpointMaxBackoff)
}

// walSize is the log file's size, zero when there is none.
func (c *walCheckpointer) walSize() int64 {
	info, err := os.Stat(c.walPath)
	if err != nil {
		return 0
	}
	return info.Size()
}

// checkpoint resets the log when it is over the threshold. It reports
// whether the log was emptied; false with a nil error means there was
// nothing to do or readers still held the log.
func (c *walCheckpointer) checkpoint(ctx context.Context) (reset bool, err error) {
	info, err := os.Stat(c.walPath)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("storage: stat write-ahead log: %w", err)
	}
	if info.Size() <= sqliteCheckpointWALBytes {
		return false, nil
	}
	return truncateWAL(ctx, c.writer)
}

// truncateWAL runs one TRUNCATE checkpoint on the writer's connection,
// waiting for readers for sqliteCheckpointBusyTimeoutMillis at most,
// and reports whether the log was emptied.
func truncateWAL(ctx context.Context, writer *sql.DB) (reset bool, err error) {
	// The writer is one connection: taking it queues this behind the
	// write in progress and holds later writes until it is returned.
	conn, err := writer.Conn(ctx)
	if err != nil {
		return false, fmt.Errorf("storage: checkpoint: %w", err)
	}
	defer func() { _ = conn.Close() }()
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA busy_timeout = %d", sqliteCheckpointBusyTimeoutMillis)); err != nil {
		return false, fmt.Errorf("storage: checkpoint busy timeout: %w", err)
	}
	// The connection goes back to the writers with its own timeout,
	// whatever happened to ctx meanwhile.
	defer func() {
		_, _ = conn.ExecContext(context.WithoutCancel(ctx), fmt.Sprintf("PRAGMA busy_timeout = %d", sqliteBusyTimeoutMillis))
	}()
	// The pragma returns one row: whether it was blocked, the frames in
	// the log, the frames copied into the database.
	var busy, logFrames, copied int
	if err := conn.QueryRowContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &logFrames, &copied); err != nil {
		return false, fmt.Errorf("storage: wal_checkpoint: %w", err)
	}
	return busy == 0, nil
}
