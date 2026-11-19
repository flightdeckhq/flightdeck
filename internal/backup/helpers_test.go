package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/flightdeckhq/flightdeck/storage"
)

// sessionID is the i-th session id the tests write: a UUID the schema's
// CHECK accepts.
func sessionID(i int) string { return fmt.Sprintf("%08x-0000-4000-8000-%012x", i, i) }

// newDatabase creates a SQLite database at path migrated to the newest
// schema with sessions sessions, and returns it open; the caller closes
// it (a closed database is one file) or keeps it open to leave its
// write-ahead log in place.
func newDatabase(t *testing.T, path string, sessions int) *storage.DB {
	t.Helper()
	ctx := context.Background()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := storage.Migrate(ctx, storage.SQLiteURL(path)); err != nil {
		t.Fatal(err)
	}
	db, err := storage.Open(ctx, storage.SQLiteURL(path))
	if err != nil {
		t.Fatal(err)
	}
	addSessions(t, db, 0, sessions)
	return db
}

// addSessions writes the sessions numbered from to from+n-1.
func addSessions(t *testing.T, db *storage.DB, from, n int) {
	t.Helper()
	for i := from; i < from+n; i++ {
		if _, err := db.ExecContext(context.Background(),
			`INSERT INTO sessions (session_id, flavor, agent_type) VALUES (?, 'backup-test', 'coding')`, sessionID(i)); err != nil {
			t.Fatal(err)
		}
	}
}

// closedDatabase is newDatabase closed: one file, no log beside it.
func closedDatabase(t *testing.T, path string, sessions int) {
	t.Helper()
	if err := newDatabase(t, path, sessions).Close(); err != nil {
		t.Fatal(err)
	}
}

// sessionsIn counts the sessions of the database at path, read-only.
func sessionsIn(t *testing.T, path string) int64 {
	t.Helper()
	f, err := storage.CheckSQLiteFile(context.Background(), path, storage.CheckOpens)
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return f.Sessions
}

// crashedDatabase leaves at path a database whose last sessions are
// only in its write-ahead log, with no process holding it: what a server
// killed with SIGKILL leaves. It holds sessions sessions.
func crashedDatabase(t *testing.T, path string, sessions int) {
	t.Helper()
	live := filepath.Join(t.TempDir(), "live.db")
	db := newDatabase(t, live, sessions)
	defer func() { _ = db.Close() }()
	if info, err := os.Stat(live + "-wal"); err != nil || info.Size() == 0 {
		t.Fatalf("the crashed database needs a write-ahead log: %v", err)
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		data, err := os.ReadFile(live + suffix)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path+suffix, data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// files maps every file under dir to the hash of its content: the state
// a refusal must leave as it found it.
func files(t *testing.T, dir string) map[string]string {
	t.Helper()
	out := map[string]string{}
	err := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(data)
		rel, _ := filepath.Rel(dir, path)
		out[rel] = hex.EncodeToString(sum[:8])
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func names(m map[string]string) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// sameFiles fails when dir's files differ from before.
func sameFiles(t *testing.T, dir string, before map[string]string) {
	t.Helper()
	after := files(t, dir)
	if len(after) != len(before) {
		var sizes []string
		for _, n := range names(after) {
			info, _ := os.Stat(filepath.Join(dir, n))
			sizes = append(sizes, fmt.Sprintf("%s=%d", n, info.Size()))
		}
		t.Errorf("the files changed:\nbefore %v\nafter  %v", names(before), sizes)
		return
	}
	for name, sum := range before {
		if after[name] != sum {
			t.Errorf("%s changed", name)
		}
	}
}

// withStep makes the restore's step hook return what hook does for the
// test.
func withStep(t *testing.T, hook func(string) error) {
	t.Helper()
	saved := step
	step = hook
	t.Cleanup(func() { step = saved })
}
