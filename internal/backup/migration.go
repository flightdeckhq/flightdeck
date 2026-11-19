package backup

import (
	"context"
	"fmt"
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

// beforeName matches the files BeforeMigration writes, and nothing a
// person or `flightdeck backup` names: before-<release>-<stamp>[-n].db.
var beforeName = regexp.MustCompile(`^before-[A-Za-z0-9._+-]+-([0-9]{8}T[0-9]{6}Z)(-[0-9]+)?\.db$`)

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
// and removes the older such copies past keepBefore. With less free
// space in dir than spaceFactor times the database (its write-ahead log
// included) it copies nothing and says so: the start goes on, since
// refusing it would drop the events of every agent until someone made
// room. A copy that fails is reported the same way.
func BeforeMigration(ctx context.Context, db, dir, release string, now time.Time) Before {
	size := fileSize(db) + fileSize(db+"-wal")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return Before{Skipped: fmt.Sprintf("no copy was taken before migrating: create %s: %v", dir, err)}
	}
	if free, ok := freeBytes(dir); ok && free < spaceFactor*uint64(size) {
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
	pruneBefore(dir, keepBefore)
	return Before{Copy: c}
}

// BeforeCopies lists the copies BeforeMigration kept in dir, the newest
// first.
func BeforeCopies(dir string) []string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	type copyFile struct{ name, stamp string }
	var found []copyFile
	for _, e := range entries {
		if m := beforeName.FindStringSubmatch(e.Name()); m != nil && e.Type().IsRegular() {
			found = append(found, copyFile{e.Name(), m[1] + m[2]})
		}
	}
	sort.Slice(found, func(i, j int) bool {
		if found[i].stamp != found[j].stamp {
			return found[i].stamp > found[j].stamp
		}
		return found[i].name > found[j].name
	})
	paths := make([]string, len(found))
	for i, f := range found {
		paths[i] = filepath.Join(dir, f.name)
	}
	return paths
}

// pruneBefore removes the copies of BeforeMigration in dir past the keep
// newest. Only names BeforeMigration writes are touched.
func pruneBefore(dir string, keep int) {
	copies := BeforeCopies(dir)
	for _, path := range copies[min(keep, len(copies)):] {
		_ = os.Remove(path)
	}
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
