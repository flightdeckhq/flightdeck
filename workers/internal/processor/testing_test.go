package processor

import (
	"context"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
	"github.com/flightdeckhq/flightdeck/workers/internal/writer"
)

// The processor's database tests run on both backends through
// storagetest.Each: SQLite on a fresh file per test, Postgres on the
// database TEST_POSTGRES_URL names (scripts/go-db-tests.sh gives the
// package one of its own). Postgres tests share that database, so each
// keeps to the rows it creates and removes them.

// each runs fn on every covered backend.
func each(t *testing.T, fn func(t *testing.T, db *storage.DB)) {
	t.Helper()
	storagetest.Each(t, fn)
}

// newTestProcessor wires a processor on db with a bus of the database's
// kind.
func newTestProcessor(db *storage.DB) *Processor {
	return NewProcessor(db, storage.NewBus(db))
}

// newTestSessionProcessor wires a session processor on db.
func newTestSessionProcessor(db *storage.DB) *SessionProcessor {
	return NewSessionProcessor(writer.New(db, storage.NewBus(db)), db)
}

func randomID(t *testing.T) string {
	t.Helper()
	return writer.NewUUID()
}

// seedAgent inserts an agent row and removes it when the test ends. It
// is registered before the sessions that reference it, so it is removed
// after them.
func seedAgent(t *testing.T, db *storage.DB, agentType, clientType, name string) string {
	t.Helper()
	ctx := context.Background()
	agentID := randomID(t)
	if _, err := db.ExecContext(ctx, `
		INSERT INTO agents (agent_id, agent_type, client_type, agent_name, user_name, hostname)
		VALUES ($1, $2, $3, $4, 'test', 'test-host')`, agentID, agentType, clientType, name); err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	t.Cleanup(func() { _, _ = db.ExecContext(ctx, `DELETE FROM agents WHERE agent_id = $1`, agentID) })
	return agentID
}

// cleanupSession removes a session's content, events and row when the
// test ends.
func cleanupSession(t *testing.T, db *storage.DB, sessionID string) {
	t.Helper()
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = db.ExecContext(ctx, `DELETE FROM event_content WHERE session_id = $1`, sessionID)
		_, _ = db.ExecContext(ctx, `DELETE FROM events WHERE session_id = $1`, sessionID)
		_, _ = db.ExecContext(ctx, `DELETE FROM sessions WHERE session_id = $1`, sessionID)
	})
}

// databaseNow reads the database's clock, at the millisecond precision
// SQLite stores.
func databaseNow(t *testing.T, db *storage.DB) time.Time {
	t.Helper()
	var now storage.Time
	if err := db.Reader().QueryRowContext(context.Background(), `SELECT `+db.Dialect.Now()).Scan(&now); err != nil {
		t.Fatalf("read the database clock: %v", err)
	}
	return now.Time.Truncate(time.Millisecond)
}

// minutesAgo is a time n minutes before now at millisecond precision,
// the coarser of the two backends', so a stored value compares equal
// to it on both.
func minutesAgo(n int) time.Time {
	return time.Now().UTC().Add(-time.Duration(n) * time.Minute).Truncate(time.Millisecond)
}

func wantTime(t *testing.T, what string, got, want time.Time) {
	t.Helper()
	if !got.Truncate(time.Millisecond).Equal(want.Truncate(time.Millisecond)) {
		t.Errorf("%s = %s, want %s", what, got, want)
	}
}

func wantClock(t *testing.T, what string, got, lo, hi time.Time) {
	t.Helper()
	got = got.Truncate(time.Millisecond)
	if got.Before(lo) || got.After(hi) {
		t.Errorf("%s = %s, want the database's clock, between %s and %s", what, got, lo, hi)
	}
}

// countRows runs a one-column count for the session.
func countRows(t *testing.T, db *storage.DB, query, sessionID string) int {
	t.Helper()
	var n int
	if err := db.Reader().QueryRowContext(context.Background(), query, sessionID).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func tokensUsed(t *testing.T, db *storage.DB, sessionID string) int {
	t.Helper()
	return countRows(t, db, `SELECT tokens_used FROM sessions WHERE session_id = $1`, sessionID)
}
