package storage_test

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// Instances that start together on one database each apply the
// migrations at start (the binary's pods under one Deployment, the
// standalone workers' replicas). They must all succeed and leave the
// schema at the newest version, not dirty.

// concurrentMigrators is how many instances start at once in these
// tests: more than the two that left a database dirty at version 30,
// and as many as a small Deployment rolls out together.
const concurrentMigrators = 4

// concurrentMigrateTimeout bounds the concurrent migrations. Each run
// on an empty database takes a few seconds; the bound turns a deadlock
// that Postgres does not detect into a failure.
const concurrentMigrateTimeout = 5 * time.Minute

// freshPostgres creates an empty database on the server of
// TEST_POSTGRES_URL, named after the database that URL names, and drops
// it when the test ends.
func freshPostgres(t *testing.T, suffix string) string {
	t.Helper()
	base := storagetest.PostgresURL(t)
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	// Postgres identifiers are at most 63 bytes.
	name := strings.TrimPrefix(u.Path, "/")
	name = name[:min(len(name), 63-len(suffix)-1)] + "_" + suffix
	admin, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	ctx := context.Background()
	if _, err := admin.ExecContext(ctx, `DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`); err != nil {
		t.Fatalf("drop database: %v", err)
	}
	if _, err := admin.ExecContext(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
		t.Fatalf("create database: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.ExecContext(context.Background(), `DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`)
	})
	u.Path = "/" + name
	return u.String()
}

// migrateTogether calls storage.Migrate concurrentMigrators times at
// once on rawURL and returns each call's error.
func migrateTogether(t *testing.T, rawURL string) []error {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), concurrentMigrateTimeout)
	defer cancel()
	var wg sync.WaitGroup
	var ready atomic.Int32
	start := make(chan struct{})
	errs := make([]error, concurrentMigrators)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ready.Add(1)
			<-start
			errs[i] = storage.Migrate(ctx, rawURL)
		}()
	}
	for ready.Load() < concurrentMigrators {
		time.Sleep(time.Millisecond)
	}
	close(start)
	wg.Wait()
	return errs
}

func requireCurrent(t *testing.T, rawURL string, b storage.Backend, errs []error) {
	t.Helper()
	for i, err := range errs {
		if err != nil {
			t.Errorf("instance %d: %v", i, err)
		}
	}
	want := maxVersion(versions(t, b))
	v, dirty, err := storage.SchemaVersion(context.Background(), rawURL)
	if err != nil || v != want || dirty {
		t.Fatalf("after %d instances migrated together: version %d, dirty %v, err %v; want %d, clean",
			len(errs), v, dirty, err, want)
	}
}

func TestMigrate_Postgres_InstancesStartingTogetherOnAnEmptyDatabase(t *testing.T) {
	fresh := freshPostgres(t, "conc_empty")
	requireCurrent(t, fresh, storage.Postgres, migrateTogether(t, fresh))
}

// Instances that start together on a database another one has already
// brought to the newest version find nothing to do.
func TestMigrate_Postgres_InstancesStartingTogetherOnACurrentDatabase(t *testing.T) {
	fresh := freshPostgres(t, "conc_current")
	if err := storage.Migrate(context.Background(), fresh); err != nil {
		t.Fatal(err)
	}
	requireCurrent(t, fresh, storage.Postgres, migrateTogether(t, fresh))
}

func TestMigrate_SQLite_GoroutinesStartingTogetherOnANewFile(t *testing.T) {
	file := storage.SQLiteURL(filepath.Join(t.TempDir(), "flightdeck.db"))
	requireCurrent(t, file, storage.SQLite, migrateTogether(t, file))
}

func TestMigrate_SQLite_GoroutinesStartingTogetherOnACurrentFile(t *testing.T) {
	file := storage.SQLiteURL(filepath.Join(t.TempDir(), "flightdeck.db"))
	if err := storage.Migrate(context.Background(), file); err != nil {
		t.Fatal(err)
	}
	requireCurrent(t, file, storage.SQLite, migrateTogether(t, file))
}

// The child mode of the test binary: with migrateChildEnv set to a
// database URL, TestMain migrates that database and exits, 0 when
// Migrate succeeds. It stands in for an instance in a process of its
// own.
const migrateChildEnv = "FLIGHTDECK_STORAGE_TEST_MIGRATE_URL"

// migrateChildBarrierEnv names a directory the children meet in: each
// writes a ready file there and waits for the parent's go file, so all
// of them call Migrate at once rather than as they happen to start.
const migrateChildBarrierEnv = "FLIGHTDECK_STORAGE_TEST_MIGRATE_BARRIER"

// migrateChildTimeout bounds one child's run, its wait at the barrier
// included.
const migrateChildTimeout = 2 * time.Minute

// barrierPoll is how often a child or the parent looks at the barrier.
const barrierPoll = time.Millisecond

func TestMain(m *testing.M) {
	if url := os.Getenv(migrateChildEnv); url != "" {
		os.Exit(migrateChild(url, os.Getenv(migrateChildBarrierEnv)))
	}
	os.Exit(m.Run())
}

func migrateChild(url, barrier string) int {
	ctx, cancel := context.WithTimeout(context.Background(), migrateChildTimeout)
	defer cancel()
	ready := filepath.Join(barrier, fmt.Sprintf("ready-%d", os.Getpid()))
	if err := os.WriteFile(ready, nil, 0o600); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "child:", err)
		return 1
	}
	for {
		if _, err := os.Stat(filepath.Join(barrier, "go")); err == nil {
			break
		}
		select {
		case <-ctx.Done():
			_, _ = fmt.Fprintln(os.Stderr, "child: no go from the parent")
			return 1
		case <-time.After(barrierPoll):
		}
	}
	if err := storage.Migrate(ctx, url); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "child:", err)
		return 1
	}
	return 0
}

// Processes, not goroutines: each child has its own SQLite connections
// and its own migrator, and only the lock file stands between them.
func TestMigrate_SQLite_ProcessesStartingTogetherOnANewFile(t *testing.T) {
	file := storage.SQLiteURL(filepath.Join(t.TempDir(), "flightdeck.db"))
	barrier := t.TempDir()
	cmds := make([]*exec.Cmd, concurrentMigrators)
	outs := make([]*bytes.Buffer, concurrentMigrators)
	for i := range cmds {
		cmd := exec.Command(os.Args[0], "-test.run=^$")
		cmd.Env = append(os.Environ(), migrateChildEnv+"="+file, migrateChildBarrierEnv+"="+barrier)
		outs[i] = &bytes.Buffer{}
		cmd.Stdout, cmd.Stderr = outs[i], outs[i]
		cmds[i] = cmd
	}
	for _, cmd := range cmds {
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(migrateChildTimeout)
	for {
		entries, err := os.ReadDir(barrier)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) == concurrentMigrators {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d of %d children reached the barrier", len(entries), concurrentMigrators)
		}
		time.Sleep(barrierPoll)
	}
	if err := os.WriteFile(filepath.Join(barrier, "go"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	errs := make([]error, concurrentMigrators)
	for i, cmd := range cmds {
		if err := cmd.Wait(); err != nil {
			errs[i] = fmt.Errorf("%v: %s", err, outs[i].String())
		}
	}
	requireCurrent(t, file, storage.SQLite, errs)
}

// A schema left dirty by an interrupted migration is reported, by every
// instance that starts on it, with what happened and how to recover,
// and stays dirty: it is not forced.
func TestMigrate_ADirtySchemaIsReportedAndLeftDirty(t *testing.T) {
	cases := []struct {
		backend storage.Backend
		url     func(t *testing.T) string
		version uint
		file    string
	}{
		{storage.SQLite, func(t *testing.T) string {
			return storage.SQLiteURL(filepath.Join(t.TempDir(), "flightdeck.db"))
		}, 1, "000001_baseline.up.sql"},
		{storage.Postgres, func(t *testing.T) string { return freshPostgres(t, "conc_dirty") }, 30, "000030_events_model_backfill_index.up.sql"},
	}
	for _, c := range cases {
		t.Run(string(c.backend), func(t *testing.T) {
			if c.backend == storage.Postgres {
				storagetest.PostgresURL(t)
			}
			rawURL := c.url(t)
			ctx := context.Background()
			if err := storage.Migrate(ctx, rawURL); err != nil {
				t.Fatal(err)
			}
			db, err := storage.Open(ctx, rawURL)
			if err != nil {
				t.Fatal(err)
			}
			// What a migrator killed during version c.version leaves.
			if _, err := db.ExecContext(ctx, "UPDATE schema_migrations SET version = $1, dirty = TRUE", c.version); err != nil {
				t.Fatal(err)
			}
			_ = db.Close()

			for i, err := range migrateTogether(t, rawURL) {
				var dirty *storage.DirtyError
				if !errors.As(err, &dirty) {
					t.Fatalf("instance %d: err = %v, want a DirtyError", i, err)
				}
				if dirty.Version != c.version || dirty.File != c.file {
					t.Fatalf("instance %d: %+v, want version %d in %s", i, dirty, c.version, c.file)
				}
				for _, want := range []string{
					fmt.Sprintf("marked dirty at version %d (%s)", c.version, c.file),
					"was interrupted",
					fmt.Sprintf("version %d with dirty = false once its changes are all there", c.version),
					fmt.Sprintf("version %d with dirty = false once they are undone", c.version-1),
				} {
					if !strings.Contains(err.Error(), want) {
						t.Errorf("instance %d: the message lacks %q: %v", i, want, err)
					}
				}
			}
			v, dirty, err := storage.SchemaVersion(ctx, rawURL)
			if err != nil || v != c.version || !dirty {
				t.Fatalf("after the refusals: version %d dirty %v err %v; want %d, still dirty", v, dirty, err, c.version)
			}
		})
	}
}

// heldLockWait is how long a Migrate is given while another session
// holds the migration lock: it must still be waiting when this ends.
const heldLockWait = 2 * time.Second

// An instance waits while another holds the migration lock, whatever
// golang-migrate's own lock says, and proceeds once it is released:
// the lock is asked for in statements that return at once.
func TestMigrate_Postgres_WaitsForTheHolderOfTheMigrationLock(t *testing.T) {
	fresh := freshPostgres(t, "conc_held")
	holder, err := sql.Open("pgx", fresh)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Close() }()
	ctx := context.Background()
	conn, err := holder.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	// The key migrate_lock.go uses: "FDMG", 1.
	if _, err := conn.ExecContext(ctx, "SELECT pg_advisory_lock(1178881351, 1)"); err != nil {
		t.Fatal(err)
	}
	short, cancel := context.WithTimeout(ctx, heldLockWait)
	err = storage.Migrate(short, fresh)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "waiting for the migration lock") {
		t.Fatalf("Migrate while the lock is held: err = %v, want it still waiting when its context ended", err)
	}
	if v, _, err := versionWithoutTheLock(t, fresh); err != nil || v != 0 {
		t.Fatalf("the waiting instance migrated: version %d, err %v", v, err)
	}
	// The holder's session ends, as a dead instance's does. Closing the
	// *sql.Conn alone would hand the session back to the pool, lock and
	// all; closing the pool ends it.
	_ = conn.Close()
	_ = holder.Close()
	if err := storage.Migrate(ctx, fresh); err != nil {
		t.Fatalf("after the holder released the lock: %v", err)
	}
	requireCurrent(t, fresh, storage.Postgres, nil)
}

// versionWithoutTheLock reads schema_migrations directly, so the check
// does not itself wait for the migration lock.
func versionWithoutTheLock(t *testing.T, rawURL string) (uint, bool, error) {
	t.Helper()
	db, err := sql.Open("pgx", rawURL)
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = db.Close() }()
	var exists bool
	if err := db.QueryRow("SELECT to_regclass('schema_migrations') IS NOT NULL").Scan(&exists); err != nil || !exists {
		return 0, false, err
	}
	var v uint
	var dirty bool
	err = db.QueryRow("SELECT version, dirty FROM schema_migrations").Scan(&v, &dirty)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return v, dirty, err
}
