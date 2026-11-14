package storage_test

import (
	"context"
	"database/sql"
	"fmt"
	"sort"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// column is one column as both backends can describe it.
type column struct {
	table, name string
	nullable    bool
	primaryKey  bool
}

func (c column) String() string {
	s := c.table + "." + c.name
	if !c.nullable {
		s += " NOT NULL"
	}
	if c.primaryKey {
		s += " PK"
	}
	return s
}

// schemaShape is the part of a schema both backends must agree on:
// tables, columns with nullability and primary-key membership, and the
// explicitly created indexes. Types differ by design (ARCHITECTURE.md,
// Storage) and constraint-backed indexes are named by each engine.
type schemaShape struct {
	tables  []string
	columns []string
	indexes []string
}

// indexesWithoutSQLiteEquivalent lists Postgres indexes the baseline
// leaves out on purpose, each with its reason.
var indexesWithoutSQLiteEquivalent = map[string]string{
	// A GIN index over the whole JSONB document; SQLite indexes
	// expressions only, and the nine sessions_context_<key>_idx
	// expression indexes (present on both) are what the facet queries
	// use.
	"sessions_context_gin": "GIN over the whole document",
}

func postgresShape(t *testing.T, db *sql.DB) schemaShape {
	t.Helper()
	ctx := context.Background()
	var shape schemaShape

	rows, err := db.QueryContext(ctx, `
		SELECT table_name FROM information_schema.tables
		WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
		  AND table_name <> 'schema_migrations' AND table_name NOT LIKE 'storagetest_%'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		shape.tables = append(shape.tables, name)
	}
	_ = rows.Close()

	rows, err = db.QueryContext(ctx, `
		SELECT c.table_name, c.column_name, c.is_nullable = 'YES',
		       EXISTS (
		         SELECT 1 FROM information_schema.table_constraints tc
		         JOIN information_schema.key_column_usage k
		           ON k.constraint_name = tc.constraint_name AND k.table_schema = tc.table_schema
		         WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = c.table_schema
		           AND tc.table_name = c.table_name AND k.column_name = c.column_name)
		FROM information_schema.columns c
		WHERE c.table_schema = 'public' AND c.table_name <> 'schema_migrations'
		  AND c.table_name NOT LIKE 'storagetest_%'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var c column
		if err := rows.Scan(&c.table, &c.name, &c.nullable, &c.primaryKey); err != nil {
			t.Fatal(err)
		}
		shape.columns = append(shape.columns, c.String())
	}
	_ = rows.Close()

	// Indexes created by CREATE INDEX: those not backing a constraint.
	rows, err = db.QueryContext(ctx, `
		SELECT i.indexname FROM pg_indexes i
		WHERE i.schemaname = 'public' AND i.tablename <> 'schema_migrations'
		  AND i.tablename NOT LIKE 'storagetest_%'
		  AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = i.indexname)`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		if _, skip := indexesWithoutSQLiteEquivalent[name]; skip {
			continue
		}
		shape.indexes = append(shape.indexes, name)
	}
	_ = rows.Close()
	return shape
}

func sqliteShape(t *testing.T, db *sql.DB) schemaShape {
	t.Helper()
	ctx := context.Background()
	var shape schemaShape

	rows, err := db.QueryContext(ctx, `
		SELECT name FROM sqlite_master WHERE type = 'table'
		  AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' AND name NOT LIKE 'storagetest_%'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		shape.tables = append(shape.tables, name)
	}
	_ = rows.Close()

	for _, table := range shape.tables {
		cols, err := db.QueryContext(ctx, fmt.Sprintf("PRAGMA table_info(%q)", table))
		if err != nil {
			t.Fatal(err)
		}
		for cols.Next() {
			var (
				cid, notnull, pk int
				name, ctype      string
				dflt             sql.NullString
			)
			if err := cols.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
				t.Fatal(err)
			}
			shape.columns = append(shape.columns, column{
				table: table, name: name, nullable: notnull == 0, primaryKey: pk > 0,
			}.String())
		}
		_ = cols.Close()
	}

	// Explicit indexes have SQL; the automatic ones for PRIMARY KEY and
	// UNIQUE constraints do not.
	rows, err = db.QueryContext(ctx, `
		SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL
		  AND tbl_name <> 'schema_migrations' AND tbl_name NOT LIKE 'storagetest_%'`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		shape.indexes = append(shape.indexes, name)
	}
	_ = rows.Close()
	return shape
}

func diffSets(t *testing.T, what string, pg, lite []string) {
	t.Helper()
	sort.Strings(pg)
	sort.Strings(lite)
	pgSet, liteSet := map[string]bool{}, map[string]bool{}
	for _, s := range pg {
		pgSet[s] = true
	}
	for _, s := range lite {
		liteSet[s] = true
	}
	var onlyPg, onlyLite []string
	for _, s := range pg {
		if !liteSet[s] {
			onlyPg = append(onlyPg, s)
		}
	}
	for _, s := range lite {
		if !pgSet[s] {
			onlyLite = append(onlyLite, s)
		}
	}
	if len(onlyPg) > 0 || len(onlyLite) > 0 {
		t.Errorf("%s differ:\n  only in postgres:\n    %s\n  only in sqlite:\n    %s",
			what, strings.Join(onlyPg, "\n    "), strings.Join(onlyLite, "\n    "))
	}
	if len(pg) == 0 {
		t.Errorf("no %s found on postgres", what)
	}
}

// TestSchemaParity opens both backends at their newest migration and
// asserts the SQLite baseline has not drifted from Postgres: same
// tables, same columns with the same nullability and primary keys, same
// explicit indexes.
func TestSchemaParity(t *testing.T) {
	pg := storagetest.OpenPostgres(t)
	lite := storagetest.OpenSQLite(t)

	pgShape := postgresShape(t, pg.DB)
	liteShape := sqliteShape(t, lite.DB)

	diffSets(t, "tables", pgShape.tables, liteShape.tables)
	diffSets(t, "columns", pgShape.columns, liteShape.columns)
	diffSets(t, "indexes", pgShape.indexes, liteShape.indexes)

	// The allowlist must stay honest: every entry names a real
	// Postgres index.
	for name := range indexesWithoutSQLiteEquivalent {
		var n int
		if err := pg.QueryRowContext(context.Background(),
			"SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1", name).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Errorf("indexesWithoutSQLiteEquivalent names %q, which Postgres does not have", name)
		}
	}
	if len(pgShape.tables) != 18 {
		t.Errorf("postgres has %d tables, want 18 (update this count with the schema)", len(pgShape.tables))
	}
}
