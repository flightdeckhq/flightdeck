package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/flightdeckhq/flightdeck/internal/backup"
	"github.com/flightdeckhq/flightdeck/internal/datadir"
	"github.com/flightdeckhq/flightdeck/storage"
)

// migrationCopy is the copy of a SQLite database a start kept before it
// migrated, for the start-up block.
type migrationCopy struct {
	backup.Before
	// from and to are the schema versions before and after.
	from, to uint
}

// copyBeforeMigrating copies the SQLite database into the data dir's
// backups/ when this start is about to migrate it: its schema version is
// above 0 (a new database has nothing to keep) and below the newest this
// binary has. nil when there is nothing to migrate, or the version cannot
// be read (Migrate then reports what is wrong). A copy that is skipped
// (too little free space) or fails is a warning: the start migrates
// all the same.
func copyBeforeMigrating(ctx context.Context, db database, layout datadir.Layout) *migrationCopy {
	from, dirty, err := storage.SchemaVersion(ctx, db.url)
	if err != nil || dirty || from == 0 {
		return nil
	}
	to, err := storage.LatestVersion(storage.SQLite)
	if err != nil || from >= to {
		return nil
	}
	started := time.Now()
	c := &migrationCopy{Before: backup.BeforeMigration(ctx, db.path, layout.Backups, version, time.Now()), from: from, to: to}
	if c.Skipped != "" {
		slog.Warn(c.Skipped, "schema_version", from, "migrating_to", to)
		return c
	}
	slog.Info("copied the database before migrating it", "copy", c.Copy.Path, "schema_version", from, "migrating_to", to,
		"bytes", c.Copy.Bytes, "took", time.Since(started).Round(time.Millisecond).String())
	return c
}

// migrateFailed is the error of a start whose migrations failed. A
// SQLite database a newer release migrated gets the copies kept before
// earlier migrations named, the files a restore takes it back to.
func migrateFailed(err error, db database, layout datadir.Layout) error {
	var newer *storage.NewerSchemaError
	if errors.As(err, &newer) && db.backend == storage.SQLite {
		if copies := backup.BeforeCopies(layout.Backups); len(copies) > 0 {
			return fmt.Errorf("database %s: %w. The copies kept before earlier migrations, newest first: %s",
				db.display, err, strings.Join(copies, ", "))
		}
	}
	return fmt.Errorf("database %s: %w", db.display, err)
}
