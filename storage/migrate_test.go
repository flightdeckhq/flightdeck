package storage_test

import (
	"context"
	"database/sql"
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

var migrationName = regexp.MustCompile(`^(\d{6})_[a-z0-9_]+\.(up|down)\.sql$`)

// versions reads the embedded migration directory of a backend and
// returns its version numbers, checking that every version is an
// up/down pair with no other files beside them.
func versions(t *testing.T, b storage.Backend) []uint {
	t.Helper()
	fsys, err := storage.MigrationsFS(b)
	if err != nil {
		t.Fatal(err)
	}
	entries, err := fs.ReadDir(fsys, ".")
	if err != nil {
		t.Fatal(err)
	}
	ups, downs := map[uint]string{}, map[uint]string{}
	for _, e := range entries {
		m := migrationName.FindStringSubmatch(e.Name())
		if m == nil {
			t.Errorf("%s: %q is not a 000NNN_name.{up,down}.sql migration file", b, e.Name())
			continue
		}
		v, _ := strconv.Atoi(m[1])
		stem := strings.TrimSuffix(strings.TrimSuffix(e.Name(), ".up.sql"), ".down.sql")
		if m[2] == "up" {
			ups[uint(v)] = stem
		} else {
			downs[uint(v)] = stem
		}
	}
	var out []uint
	for v, stem := range ups {
		if downs[v] != stem {
			t.Errorf("%s: %s.up.sql has no matching down file", b, stem)
		}
		out = append(out, v)
	}
	for v, stem := range downs {
		if _, ok := ups[v]; !ok {
			t.Errorf("%s: %s.down.sql has no matching up file", b, stem)
		}
	}
	return out
}

func maxVersion(vs []uint) uint {
	var m uint
	for _, v := range vs {
		if v > m {
			m = v
		}
	}
	return m
}

func TestMigrations_EveryVersionIsAPairOnBothBackends(t *testing.T) {
	pg := versions(t, storage.Postgres)
	lite := versions(t, storage.SQLite)
	if len(pg) < 36 {
		t.Errorf("postgres has %d migrations, want at least the 36 of the SQLite baseline", len(pg))
	}
	if len(lite) < 1 || lite[0] == 0 {
		t.Fatalf("sqlite migrations: %v", lite)
	}
	// From the first SQLite version on, both directories list the same
	// versions (the baseline is 000001; a later pair shares a number).
	pgSet := map[uint]bool{}
	for _, v := range pg {
		pgSet[v] = true
	}
	for _, v := range lite {
		if v == 1 {
			continue // the baseline stands in for Postgres 000001..000036
		}
		if !pgSet[v] {
			t.Errorf("sqlite migration %06d has no postgres pair", v)
		}
	}
	if maxVersion(pg) > 36 {
		for _, v := range pg {
			if v <= 36 {
				continue
			}
			found := false
			for _, l := range lite {
				found = found || l == v
			}
			if !found {
				t.Errorf("postgres migration %06d has no sqlite pair", v)
			}
		}
	}
}

func TestMigrate_SQLite_UpDownUp(t *testing.T) {
	ctx := context.Background()
	rawURL := "sqlite://" + filepath.Join(t.TempDir(), "m.db")

	v, dirty, err := storage.SchemaVersion(ctx, rawURL)
	if err != nil || v != 0 || dirty {
		t.Fatalf("fresh file: version %d dirty %v err %v", v, dirty, err)
	}
	if err := storage.Migrate(ctx, rawURL); err != nil {
		t.Fatal(err)
	}
	want := maxVersion(versions(t, storage.SQLite))
	if v, dirty, _ = storage.SchemaVersion(ctx, rawURL); v != want || dirty {
		t.Fatalf("after up: version %d dirty %v, want %d clean", v, dirty, want)
	}
	// Idempotent.
	if err := storage.Migrate(ctx, rawURL); err != nil {
		t.Fatalf("second up: %v", err)
	}

	db, err := storage.Open(ctx, rawURL)
	if err != nil {
		t.Fatal(err)
	}
	if n := queryInt(t, db, "SELECT COUNT(*) FROM access_tokens WHERE name = 'Development Token' AND prefix = 'tok_dev_' AND salt = 'd0d0cafed00dfaceb00bba5eba11f001' AND token_hash = '0c805243ecd4f6f59bec56235a1901d97ad8cf0771020f2d44da428827f1145e'"); n != 1 {
		t.Errorf("dev token seed rows: %d, want 1", n)
	}
	if n := queryInt(t, db, "SELECT COUNT(*) FROM mcp_policies WHERE scope = 'global' AND mode = 'blocklist'"); n != 1 {
		t.Errorf("global mcp policy seed rows: %d, want 1", n)
	}
	// The defaults produce canonical UUIDs and layout timestamps.
	var id, created string
	if err := db.QueryRowContext(ctx, "SELECT id, CAST(created_at AS TEXT) FROM access_tokens LIMIT 1").Scan(&id, &created); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(id) {
		t.Errorf("default id %q is not a version-4 UUID", id)
	}
	if _, err := time.Parse(storage.TimeLayout, created); err != nil {
		t.Errorf("default created_at %q is not in TimeLayout: %v", created, err)
	}
	// Foreign keys are enforced and JSON columns are checked.
	if _, err := db.ExecContext(ctx, "INSERT INTO events (session_id, flavor, event_type) VALUES ($1, 'f', 'x')", id); err == nil {
		t.Error("insert with a dangling session_id succeeded; foreign keys are off")
	}
	if _, err := db.ExecContext(ctx, "INSERT INTO sessions (session_id, flavor, agent_type, context) VALUES ($1, 'f', 'coding', 'not json')", id); err == nil {
		t.Error("insert of invalid JSON succeeded; the json_valid check is missing")
	}
	_ = db.Close()

	if err := storage.MigrateDown(ctx, rawURL); err != nil {
		t.Fatal(err)
	}
	if v, _, _ = storage.SchemaVersion(ctx, rawURL); v != 0 {
		t.Fatalf("after down: version %d, want 0", v)
	}
	db, err = storage.Open(ctx, rawURL)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if n := queryInt(t, db, "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'"); n != 0 {
		t.Errorf("%d tables left after down", n)
	}
	if err := storage.Migrate(ctx, rawURL); err != nil {
		t.Fatalf("up after down: %v", err)
	}
}

// TestMigrate_Postgres_FreshDatabase migrates an empty database of its
// own through the embedded files (not the workers' file-based runner)
// to the newest version.
func TestMigrate_Postgres_FreshDatabase(t *testing.T) {
	base := storagetest.PostgresURL(t)
	ctx := context.Background()
	admin, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = admin.Close() }()
	name := fmt.Sprintf("fd_storage_mig_%d_%d", os.Getpid(), time.Now().UnixNano()%1_000_000)
	if _, err := admin.ExecContext(ctx, `CREATE DATABASE "`+name+`"`); err != nil {
		t.Fatalf("create database: %v", err)
	}
	defer func() {
		_, _ = admin.ExecContext(context.Background(), `DROP DATABASE IF EXISTS "`+name+`" WITH (FORCE)`)
	}()
	u, err := url.Parse(base)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + name
	fresh := u.String()

	if err := storage.Migrate(ctx, fresh); err != nil {
		t.Fatal(err)
	}
	want := maxVersion(versions(t, storage.Postgres))
	v, dirty, err := storage.SchemaVersion(ctx, fresh)
	if err != nil || v != want || dirty {
		t.Fatalf("version %d dirty %v err %v, want %d clean", v, dirty, err, want)
	}
	if err := storage.Migrate(ctx, fresh); err != nil {
		t.Fatalf("second up: %v", err)
	}
	db, err := storage.Open(ctx, fresh)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if n := queryInt(t, db, "SELECT COUNT(*) FROM access_tokens WHERE name = 'Development Token'"); n != 1 {
		t.Errorf("dev token seed rows: %d, want 1", n)
	}
}
