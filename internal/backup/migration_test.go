package backup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The copies kept before migrations are the latest keepBefore of the ones
// this binary wrote; nothing else in the directory is touched: not
// `flightdeck backup`'s copies, not a file a person named like one of
// its own (before-mine-<stamp>.db), and not one with a stamp in the
// future, which does not push the real copies out either.
func TestBeforeMigration_KeepsTheTwoLatestCopies(t *testing.T) {
	db := filepath.Join(t.TempDir(), "flightdeck.db")
	closedDatabase(t, db, 2)
	dir := filepath.Join(t.TempDir(), "backups")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	mine := map[string]string{
		"flightdeck-20260101T000000Z.db":  "a backup",
		"notes.txt":                       "notes",
		"before-mine.db":                  "a name of mine",
		"before-mine-20260101T000000Z.db": "a look-alike of mine",
		"before-v9-29991231T235959Z.db":   "a future stamp",
	}
	for name, content := range mine {
		_ = os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600)
	}
	start := time.Date(2026, 11, 19, 8, 0, 0, 0, time.UTC)
	var kept []string
	for i := range 3 {
		b := BeforeMigration(context.Background(), db, dir, "v0.12.0", start.Add(time.Duration(i)*time.Second))
		if b.Skipped != "" || b.Copy.Path == "" || b.Copy.File.Sessions != 2 {
			t.Fatalf("copy %d: %+v", i, b)
		}
		kept = append(kept, b.Copy.Path)
	}
	got := BeforeCopies(dir)
	if len(got) != 2 || got[0] != kept[2] || got[1] != kept[1] {
		t.Errorf("the copies kept are %v, want the two latest %v", got, kept[1:])
	}
	if filepath.Base(kept[2]) != "before-v0.12.0-20261119T080002Z.db" {
		t.Errorf("the copy is named %s", filepath.Base(kept[2]))
	}
	for name, content := range mine {
		if data, err := os.ReadFile(filepath.Join(dir, name)); err != nil || string(data) != content {
			t.Errorf("%s was touched: %q, %v", name, data, err)
		}
	}
}

// The record is the only thing that makes a file this binary's: an entry
// whose file is gone is dropped, and a recorded file a person replaced
// (another size or time) is no longer listed or removed.
func TestBeforeMigration_TheRecordDecidesWhatIsItsOwn(t *testing.T) {
	db := filepath.Join(t.TempDir(), "flightdeck.db")
	closedDatabase(t, db, 1)
	dir := filepath.Join(t.TempDir(), "backups")
	start := time.Date(2026, 11, 19, 8, 0, 0, 0, time.UTC)
	first := BeforeMigration(context.Background(), db, dir, "v1", start)
	// A record that also names a file that is not there.
	record, _ := os.ReadFile(filepath.Join(dir, beforeRecord))
	withMissing := strings.Replace(string(record), "[", `[{"name":"before-v0-20250101T000000Z.db","bytes":1,"modified":"2025-01-01T00:00:00Z","taken":"2025-01-01T00:00:00Z"},`, 1)
	if err := os.WriteFile(filepath.Join(dir, beforeRecord), []byte(withMissing), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := BeforeCopies(dir); len(got) != 1 || got[0] != first.Copy.Path {
		t.Fatalf("with a missing file recorded, the copies are %v", got)
	}
	// The person replaces the first copy with a file of their own.
	if err := os.WriteFile(first.Copy.Path, []byte("mine now"), 0o600); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 3; i++ {
		if b := BeforeMigration(context.Background(), db, dir, "v1", start.Add(time.Duration(i)*time.Second)); b.Copy.Path == "" {
			t.Fatalf("copy %d: %s", i, b.Skipped)
		}
	}
	if data, err := os.ReadFile(first.Copy.Path); err != nil || string(data) != "mine now" {
		t.Errorf("a recorded file the person replaced was removed or changed: %q, %v", data, err)
	}
	got := BeforeCopies(dir)
	if len(got) != 2 {
		t.Errorf("the copies are %v, want the two latest it wrote", got)
	}
	for _, path := range got {
		if path == first.Copy.Path {
			t.Errorf("a replaced file is listed as a copy: %v", got)
		}
	}
	if strings.Contains(readFile(t, filepath.Join(dir, beforeRecord)), "before-v0-20250101T000000Z.db") {
		t.Error("the record still names a file that is not there")
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestBeforeMigration_SkipsTheCopyWhenTheDiskIsNearlyFull(t *testing.T) {
	db := filepath.Join(t.TempDir(), "flightdeck.db")
	closedDatabase(t, db, 1)
	size := uint64(fileSize(db))
	saved := freeSpace
	freeSpace = func(string) (uint64, bool) { return 2*size - 1, true }
	defer func() { freeSpace = saved }()
	dir := filepath.Join(t.TempDir(), "backups")
	b := BeforeMigration(context.Background(), db, dir, "v0.12.0", time.Now())
	if b.Copy.Path != "" || !strings.Contains(b.Skipped, "free") || !strings.Contains(b.Skipped, "flightdeck backup") {
		t.Errorf("a nearly full disk: %+v", b)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Errorf("the skipped copy left %d files", len(entries))
	}
	freeSpace = func(string) (uint64, bool) { return 2 * size, true }
	if b := BeforeMigration(context.Background(), db, dir, "v0.12.0", time.Now()); b.Copy.Path == "" {
		t.Errorf("twice the database's size free is enough: %+v", b)
	}
}

func TestBeforeMigration_KeepsTheReleaseNameUsableInAFileName(t *testing.T) {
	db := filepath.Join(t.TempDir(), "flightdeck.db")
	closedDatabase(t, db, 0)
	dir := t.TempDir()
	b := BeforeMigration(context.Background(), db, dir, "v1.2/3 rc", time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))
	if filepath.Base(b.Copy.Path) != "before-v1.2_3_rc-20260102T030405Z.db" {
		t.Errorf("the copy is %s (%s)", b.Copy.Path, b.Skipped)
	}
}
