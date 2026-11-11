package storage

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// walTestDeadline bounds the waits of the write-ahead log tests. The
// checkpointer looks at the log once a second and a reset takes
// milliseconds; half a minute turns a log that is never reset into a
// failure without racing a loaded CI host.
const walTestDeadline = 30 * time.Second

// openWALTestDB opens a fresh SQLite database with a table to fill.
func openWALTestDB(t *testing.T) (*DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fd.db")
	db, err := Open(context.Background(), SQLiteURL(path))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.ExecContext(context.Background(), `CREATE TABLE wal_fill (id INTEGER PRIMARY KEY, pad BLOB NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	return db, path + "-wal"
}

func walBytes(t *testing.T, walPath string) int64 {
	t.Helper()
	info, err := os.Stat(walPath)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return info.Size()
}

// overlappingReader keeps a read in progress across every write: it
// holds one read transaction open and ends it only after the next one
// has begun (rotate). No read lasts long, yet every commit happens
// under a read that began before it, which is the load under which
// SQLite's own checkpoint never gets to start the log over (a
// dashboard polling while events arrive).
type overlappingReader struct {
	t  *testing.T
	db *DB
	tx *sql.Tx
}

func newOverlappingReader(t *testing.T, db *DB) *overlappingReader {
	t.Helper()
	r := &overlappingReader{t: t, db: db}
	r.rotate()
	t.Cleanup(r.end)
	return r
}

// rotate begins a new read and then ends the previous one.
func (r *overlappingReader) rotate() {
	r.t.Helper()
	ctx := context.Background()
	next, err := r.db.Reader().BeginTx(ctx, nil)
	if err != nil {
		r.t.Fatalf("begin read: %v", err)
	}
	// The transaction's snapshot is taken by its first read.
	var id int
	if err := next.QueryRowContext(ctx, `SELECT COALESCE(MAX(id), 0) FROM wal_fill`).Scan(&id); err != nil {
		r.t.Fatalf("read: %v", err)
	}
	r.end()
	r.tx = next
}

func (r *overlappingReader) end() {
	if r.tx != nil {
		_ = r.tx.Rollback()
		r.tx = nil
	}
}

// fillWAL writes rows, each under a read that began before it, until
// the log is past the checkpointer's threshold, or until the log
// shrinks, which means the checkpointer reset it on the way. It
// reports the largest size it saw.
func fillWAL(t *testing.T, db *DB, walPath string, r *overlappingReader) (peak int64) {
	t.Helper()
	deadline := time.Now().Add(walTestDeadline)
	for {
		size := walBytes(t, walPath)
		if size < peak || size > sqliteCheckpointWALBytes {
			return max(peak, size)
		}
		peak = size
		if time.Now().After(deadline) {
			t.Fatalf("the log did not pass %d bytes within %s; it is %d", sqliteCheckpointWALBytes, walTestDeadline, size)
		}
		// 64 KiB of random bytes per row: about sixteen pages a write.
		if _, err := db.ExecContext(context.Background(), `INSERT INTO wal_fill (pad) VALUES (randomblob(65536))`); err != nil {
			t.Fatalf("write: %v", err)
		}
		r.rotate()
	}
}

func requireNoRowLost(t *testing.T, db *DB) {
	t.Helper()
	var rows, last int
	if err := db.Reader().QueryRowContext(context.Background(), `SELECT COUNT(*), MAX(id) FROM wal_fill`).Scan(&rows, &last); err != nil {
		t.Fatal(err)
	}
	if rows != last || rows == 0 {
		t.Fatalf("%d rows, last id %d: rows were lost across the reset", rows, last)
	}
}

// Under reads that overlap every write the log grows past the size
// SQLite's own checkpoint keeps it at, and a TRUNCATE checkpoint
// empties it as soon as the readers have moved off it. The background
// loop is stopped so the test drives each attempt itself.
func TestSQLiteWAL_GrowsUnderOverlappingReadsUntilACheckpointResetsIt(t *testing.T) {
	db, walPath := openWALTestDB(t)
	db.checkpointer.Stop()
	ctx := context.Background()
	reader := newOverlappingReader(t, db)
	if peak := fillWAL(t, db, walPath, reader); peak <= sqliteCheckpointWALBytes {
		t.Fatalf("the log shrank at %d bytes with the checkpointer stopped", peak)
	}

	// The read in progress is on the log: this attempt copies the log
	// into the database, cannot empty it, and gives up.
	reset, err := truncateWAL(ctx, db.DB)
	if err != nil || reset {
		t.Fatalf("checkpoint under a read on the log: reset=%v err=%v, want it postponed", reset, err)
	}
	// Everything is copied now, so the next read no longer uses the
	// log; once the previous one has ended the log can be emptied,
	// with a read still in progress.
	reader.rotate()
	reset, err = truncateWAL(ctx, db.DB)
	if err != nil || !reset {
		t.Fatalf("checkpoint once the readers are off the log: reset=%v err=%v", reset, err)
	}
	if size := walBytes(t, walPath); size != 0 {
		t.Fatalf("the log is %d bytes after a reset, want 0", size)
	}
	// Writes and reads go on after the reset, and nothing was lost.
	if _, err := db.ExecContext(ctx, `INSERT INTO wal_fill (pad) VALUES (randomblob(16))`); err != nil {
		t.Fatalf("write after the reset: %v", err)
	}
	reader.rotate()
	requireNoRowLost(t, db)
}

// The background loop notices a log past the threshold and resets it
// with no help, under the same readers: after the writes stop, nothing
// else can shrink the log.
func TestSQLiteWAL_TheCheckpointerResetsALogPastTheThreshold(t *testing.T) {
	db, walPath := openWALTestDB(t)
	reader := newOverlappingReader(t, db)
	peak := fillWAL(t, db, walPath, reader)
	deadline := time.Now().Add(walTestDeadline)
	for walBytes(t, walPath) > sqliteCheckpointWALBytes {
		if time.Now().After(deadline) {
			t.Fatalf("the log is still %d bytes %s after it passed the threshold (peak %d)", walBytes(t, walPath), walTestDeadline, peak)
		}
		// Reads keep overlapping while the loop does its work.
		reader.rotate()
		time.Sleep(10 * time.Millisecond)
	}
	requireNoRowLost(t, db)
}

// A read that is still open when the checkpoint runs postpones the
// reset: the checkpoint gives up within its busy timeout, the writer
// is free again, and the log is reset once the read has finished.
func TestSQLiteWAL_ALongReadPostponesTheResetWithoutBlockingWrites(t *testing.T) {
	db, walPath := openWALTestDB(t)
	db.checkpointer.Stop()
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `INSERT INTO wal_fill (pad) VALUES (randomblob(16))`); err != nil {
		t.Fatal(err)
	}
	// A read transaction pinned to the log's current state.
	long, err := db.Reader().BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = long.Rollback() }()
	var n int
	if err := long.QueryRowContext(ctx, `SELECT COUNT(*) FROM wal_fill`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	// The writes go on under that one read, which never ends.
	deadline := time.Now().Add(walTestDeadline)
	for walBytes(t, walPath) <= sqliteCheckpointWALBytes {
		if time.Now().After(deadline) {
			t.Fatalf("the log did not pass %d bytes within %s", sqliteCheckpointWALBytes, walTestDeadline)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO wal_fill (pad) VALUES (randomblob(65536))`); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	start := time.Now()
	reset, err := truncateWAL(ctx, db.DB)
	if err != nil {
		t.Fatalf("checkpoint under a long read: %v", err)
	}
	if reset {
		t.Fatal("the log was reset under a read that still needs it")
	}
	// It waited no longer than its own timeout (with slack for the
	// copy it did do), not SQLite's five-second one.
	if took := time.Since(start); took > time.Duration(sqliteBusyTimeoutMillis)*time.Millisecond {
		t.Fatalf("the checkpoint held the writer for %s", took)
	}
	// The writer's connection has its normal busy timeout back.
	var busyTimeout int
	if err := db.QueryRowContext(ctx, `PRAGMA busy_timeout`).Scan(&busyTimeout); err != nil {
		t.Fatal(err)
	}
	if busyTimeout != sqliteBusyTimeoutMillis {
		t.Fatalf("writer busy_timeout is %d after a checkpoint, want %d", busyTimeout, sqliteBusyTimeoutMillis)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO wal_fill (pad) VALUES (randomblob(16))`); err != nil {
		t.Fatalf("write after a postponed reset: %v", err)
	}
	// The long read sees the state it started with.
	var still int
	if err := long.QueryRowContext(ctx, `SELECT COUNT(*) FROM wal_fill`).Scan(&still); err != nil || still != n {
		t.Fatalf("the long read sees %d rows (%v), want the %d it started with", still, err, n)
	}

	if err := long.Rollback(); err != nil {
		t.Fatal(err)
	}
	reset, err = truncateWAL(ctx, db.DB)
	if err != nil || !reset {
		t.Fatalf("checkpoint after the read ended: reset=%v err=%v", reset, err)
	}
	if size := walBytes(t, walPath); size != 0 {
		t.Fatalf("the log is %d bytes after a reset, want 0", size)
	}
}

func TestCheckpointBackoff_DoublesToTheCap(t *testing.T) {
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second, 30 * time.Second}
	for i, w := range want {
		if got := checkpointBackoff(i + 1); got != w {
			t.Errorf("checkpointBackoff(%d) = %s, want %s", i+1, got, w)
		}
	}
	if got := checkpointBackoff(1000); got != sqliteCheckpointMaxBackoff {
		t.Errorf("checkpointBackoff(1000) = %s, want the cap", got)
	}
}

// Close stops the checkpointer and leaves one file.
func TestSQLiteClose_StopsTheCheckpointerAndRemovesTheLog(t *testing.T) {
	db, walPath := openWALTestDB(t)
	if _, err := db.ExecContext(context.Background(), `INSERT INTO wal_fill (pad) VALUES (randomblob(4096))`); err != nil {
		t.Fatal(err)
	}
	if walBytes(t, walPath) == 0 {
		t.Fatal("expected a write-ahead log while the database is open")
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-db.checkpointer.done:
	default:
		t.Fatal("the checkpointer is still running after Close")
	}
	if _, err := os.Stat(walPath); !os.IsNotExist(err) {
		t.Fatalf("the log is still there after Close (stat: %v)", err)
	}
}
