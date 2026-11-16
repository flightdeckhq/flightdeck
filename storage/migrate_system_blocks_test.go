package storage_test

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// systemBlocksMigration is the stem of the migration that adds
// event_content.system_blocks, on both backends.
const systemBlocksMigration = "000038_event_content_system_blocks"

// freshDatabase returns the URL of an empty database of the backend that
// only this test uses: a file in the test's temp directory, or a
// Postgres database created on TEST_POSTGRES_URL's server and dropped
// when the test ends. The migration's down file drops a column, which
// must not reach the package's shared Postgres database.
func freshDatabase(t *testing.T, b storage.Backend) string {
	t.Helper()
	if b == storage.SQLite {
		return "sqlite://" + filepath.Join(t.TempDir(), "m.db")
	}
	base := storagetest.PostgresURL(t)
	admin, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Close() })
	name := fmt.Sprintf("fd_storage_sysblk_%d_%d", os.Getpid(), time.Now().UnixNano()%1_000_000)
	if _, err := admin.ExecContext(context.Background(), `CREATE DATABASE "`+name+`"`); err != nil {
		t.Fatalf("create database: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.ExecContext(context.Background(), `DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`)
	})
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	return u.String()
}

// migrationFile is the text of one of the backend's embedded migration
// files.
func migrationFile(t *testing.T, b storage.Backend, name string) string {
	t.Helper()
	fsys, err := storage.MigrationsFS(b)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := fs.ReadFile(fsys, name)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// The system_blocks migration runs up, down and up again over rows that
// exist, on both backends: the column takes a list, refuses any other
// JSON and a row with system_prompt set as well; down removes the column
// and keeps the rows and their system_prompt; up adds it back with the
// same checks.
func TestMigration_EventContentSystemBlocks_UpDownUp(t *testing.T) {
	for _, b := range storagetest.Backends(t) {
		t.Run(string(b), func(t *testing.T) {
			ctx := context.Background()
			rawURL := freshDatabase(t, b)
			if err := storage.Migrate(ctx, rawURL); err != nil {
				t.Fatal(err)
			}
			db, err := storage.Open(ctx, rawURL)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = db.Close() })

			sessionID := "5a5a5a5a-0000-4000-8000-000000000038"
			mustExec(t, db, `INSERT INTO sessions (session_id, flavor, agent_type) VALUES ($1, 'migration-38', 'coding')`, sessionID)
			insert := func(eventID string, text, blocks any) error {
				_, err := db.ExecContext(ctx, `
					INSERT INTO event_content (event_id, session_id, provider, model, system_prompt, system_blocks, messages, response)
					VALUES ($1, $2, 'anthropic', 'm', $3, $4, '[]', '{}')`, eventID, sessionID, text, blocks)
				return err
			}
			eventID := func(n int) string { return fmt.Sprintf("5a5a5a5a-0000-4000-8000-%012d", n) }
			checks := func(stage string, first int) {
				t.Helper()
				if err := insert(eventID(first), nil, `[{"type":"text","text":"x","cache_control":{"type":"ephemeral"}}]`); err != nil {
					t.Fatalf("%s: a list in system_blocks: %v", stage, err)
				}
				for i, bad := range []struct {
					what         string
					text, blocks any
				}{
					{"an object", nil, `{"type":"text","text":"x"}`},
					{"a string", nil, `"x"`},
					{"a number", nil, `1`},
					{"both columns", "x", `[{"type":"text","text":"x"}]`},
				} {
					if err := insert(eventID(first+1+i), bad.text, bad.blocks); err == nil || !storage.IsDataError(err) {
						t.Errorf("%s: %s: err = %v, want a check violation", stage, bad.what, err)
					}
				}
			}

			// On Postgres the check is added NOT VALID (no scan of the
			// existing rows under the table's exclusive lock) and still
			// checks every new row, which checks() shows.
			notValidated := func(stage string) {
				t.Helper()
				if b != storage.Postgres {
					return
				}
				if v := queryString(t, db, `SELECT CAST(convalidated AS TEXT) FROM pg_constraint WHERE conname = 'event_content_system_blocks_check'`); v != "false" {
					t.Errorf("%s: event_content_system_blocks_check convalidated = %s, want false (NOT VALID)", stage, v)
				}
			}
			notValidated("up")
			checks("up", 10)
			if err := insert(eventID(1), "be brief", nil); err != nil {
				t.Fatalf("a text system: %v", err)
			}

			mustExec(t, db, migrationFile(t, b, systemBlocksMigration+".down.sql"))
			if _, err := db.ExecContext(ctx, `SELECT system_blocks FROM event_content`); err == nil {
				t.Fatal("system_blocks is still there after the down file")
			}
			if n := queryInt(t, db, `SELECT COUNT(*) FROM event_content WHERE session_id = $1`, sessionID); n != 2 {
				t.Errorf("%d rows after down, want the 2 stored", n)
			}
			if got := queryString(t, db, `SELECT system_prompt FROM event_content WHERE event_id = $1`, eventID(1)); got != "be brief" {
				t.Errorf("system_prompt after down = %q", got)
			}

			mustExec(t, db, migrationFile(t, b, systemBlocksMigration+".up.sql"))
			if n := queryInt(t, db, `SELECT COUNT(*) FROM event_content WHERE system_blocks IS NULL`); n != 2 {
				t.Errorf("%d rows with system_blocks NULL after up again, want 2", n)
			}
			notValidated("up again")
			checks("up again", 20)
		})
	}
}
