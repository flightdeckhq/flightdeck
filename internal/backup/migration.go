package backup

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// keepBefore is how many copies taken before a migration are kept: the
// way back from the latest upgrade, and from the one before it in case
// the latest is found wrong only later. Each is a whole database, so
// more would grow a small disk with every release.
const keepBefore = 2

// spaceFactor is the free space a copy before a migration needs, in
// multiples of the database: the copy itself, and as much again for
// what the migration and the server write next. Below it the copy is
// skipped rather than fill the disk the database lives on.
const spaceFactor = 2

// beforeRecord, in the backups directory, lists the copies BeforeMigration
// wrote, with the size and modification time each had: the only files it
// ever lists or removes. A file named like one but not in the record (a
// person's own before-….db), or in it but no longer the same size and
// time (replaced since), is not this binary's and is left alone.
const beforeRecord = "before-copies.json"

// maxRecordBytes bounds what is read of the record: a line per copy, and
// a few copies.
const maxRecordBytes = 64 << 10

// recordedCopy is one line of the record.
type recordedCopy struct {
	// Name is the copy's file name in the backups directory.
	Name string `json:"name"`
	// Bytes and Modified are its size and modification time once written.
	Bytes    int64     `json:"bytes"`
	Modified time.Time `json:"modified"`
	// Taken is when it was taken, which orders the copies.
	Taken time.Time `json:"taken"`
}

// freeSpace reads the free space of a directory's file system; the tests
// replace it to stand for a disk that is nearly full.
var freeSpace = freeBytes

// releaseChars keeps a release version usable in a file name.
var releaseChars = regexp.MustCompile(`[^A-Za-z0-9._+-]`)

// Before is the outcome of the copy before a migration.
type Before struct {
	// Copy is the copy kept; its Path is "" when none was taken.
	Copy Copy
	// Skipped says why none was taken, for the start-up block and the
	// log; "" when one was.
	Skipped string
}

// BeforeMigration copies the SQLite database at db into dir (created,
// mode 0700) as before-<release>-<UTC stamp>.db, before a start applies
// a migration to it, checks that the copy opens at the version it had,
// records it (beforeRecord), and removes the recorded copies past
// keepBefore, never another file. With less free
// space in dir than spaceFactor times the database (its write-ahead log
// included) it copies nothing and says so: the start goes on, since
// refusing it would drop the events of every agent until someone made
// room. A copy that fails is reported the same way.
func BeforeMigration(ctx context.Context, db, dir, release string, now time.Time) Before {
	size := fileSize(db) + fileSize(db+"-wal")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Before{Skipped: fmt.Sprintf("no copy was taken before migrating: create %s: %v", dir, err)}
	}
	if free, ok := freeSpace(dir); ok && free < spaceFactor*uint64(size) {
		return Before{Skipped: fmt.Sprintf("no copy was taken before migrating: %s has %s free, and a copy needs %s "+
			"(twice the database); make room, or take one with flightdeck backup <file on another disk>",
			dir, human(free), human(spaceFactor*uint64(size)))}
	}
	release = releaseChars.ReplaceAllString(release, "_")
	name, err := freeName("before-"+release+"-"+stamp(now), ".db", func(n string) bool { return exists(filepath.Join(dir, n)) })
	if err != nil {
		return Before{Skipped: "no copy was taken before migrating: " + err.Error()}
	}
	c, err := writeCopy(ctx, db, filepath.Join(dir, name), storage.CheckOpens)
	if err != nil {
		return Before{Skipped: "no copy was taken before migrating: " + err.Error()}
	}
	info, err := os.Stat(c.Path)
	if err != nil {
		return Before{Copy: c}
	}
	copies := append(recordedCopies(dir), recordedCopy{Name: name, Bytes: info.Size(), Modified: info.ModTime(), Taken: now.UTC()})
	sortNewestFirst(copies)
	for _, old := range copies[min(keepBefore, len(copies)):] {
		_ = os.Remove(filepath.Join(dir, old.Name))
	}
	_ = writeRecord(dir, copies[:min(keepBefore, len(copies))])
	return Before{Copy: c}
}

// BeforeCopies lists the copies BeforeMigration wrote in dir that are
// still there as it wrote them, the newest first.
func BeforeCopies(dir string) []string {
	copies := recordedCopies(dir)
	sortNewestFirst(copies)
	paths := make([]string, len(copies))
	for i, c := range copies {
		paths[i] = filepath.Join(dir, c.Name)
	}
	return paths
}

// recordedCopies are the record's copies that are still this binary's:
// a plain file in dir of the recorded size and modification time.
func recordedCopies(dir string) []recordedCopy {
	f, err := os.Open(filepath.Join(dir, beforeRecord))
	if err != nil {
		return nil
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, maxRecordBytes))
	if err != nil {
		return nil
	}
	var listed []recordedCopy
	if json.Unmarshal(data, &listed) != nil {
		return nil
	}
	var ours []recordedCopy
	for _, c := range listed {
		if filepath.Base(c.Name) != c.Name {
			continue
		}
		info, err := os.Lstat(filepath.Join(dir, c.Name))
		if err == nil && info.Mode().IsRegular() && info.Size() == c.Bytes && info.ModTime().Equal(c.Modified) {
			ours = append(ours, c)
		}
	}
	return ours
}

func sortNewestFirst(copies []recordedCopy) {
	sort.SliceStable(copies, func(i, j int) bool { return copies[i].Taken.After(copies[j].Taken) })
}

// writeRecord writes the record of dir, mode 0600, through a temporary
// file and a rename, so a reader never finds half of it.
func writeRecord(dir string, copies []recordedCopy) error {
	data, err := json.MarshalIndent(copies, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := createPartial(dir, beforeRecord)
	if err != nil {
		return err
	}
	if err := os.WriteFile(tmp, append(data, '\n'), 0o600); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, filepath.Join(dir, beforeRecord)); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func fileSize(path string) int64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	return info.Size()
}

// human spells a byte count with a binary unit.
func human(n uint64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := uint64(unit), 0
	for v := n / unit; v >= unit; v /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %siB", float64(n)/float64(div), strings.Split("K M G T P E", " ")[exp])
}
