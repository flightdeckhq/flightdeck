package processor

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
	"github.com/flightdeckhq/flightdeck/workers/internal/logcap"
)

// oversizedLen is the size of the hostile value below: the NATS payload
// limit, the largest string a publisher that skips the ingestion API can
// put in a field.
const oversizedLen = 1 << 20

// lockedBuffer is a bytes.Buffer the test's logger writes into.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) linesWith(substr string) []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	var out []string
	for _, l := range strings.Split(b.buf.String(), "\n") {
		if strings.Contains(l, substr) {
			out = append(out, l)
		}
	}
	return out
}

// A session_start whose parent_session_id is a megabyte of non-UUID text
// fails on both backends, and the worker's log lines carry the id and
// the error capped, never the megabyte. On Postgres the parent lookup
// fails the uuid cast, and both the writer's error and Postgres's quote
// the whole input; on SQLite the lookup finds no such row and the
// parent stub's insert fails the uuid CHECK, whose message quotes
// nothing, so the cap is proven on the stub's log line.
func TestHandleSessionStart_CapsAHugeParentIDOnItsLogLine(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()

		var logs lockedBuffer
		previous := slog.Default()
		slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
		t.Cleanup(func() { slog.SetDefault(previous) })

		sessionID := randomID(t)
		agentID := randomID(t)
		cleanupSession(t, db, sessionID)
		t.Cleanup(func() { _, _ = db.ExecContext(ctx, `DELETE FROM agents WHERE agent_id = $1`, agentID) })

		const marker = "PARENTMARKER"
		parent := marker + strings.Repeat("p", oversizedLen-len(marker))
		sp := newTestSessionProcessor(db)
		err := sp.HandleSessionStart(ctx, consumer.EventPayload{
			SessionID: sessionID, EventType: "session_start",
			Flavor: "processor-test-log-caps", AgentType: "coding",
			AgentID: agentID, ClientType: "flightdeck_sensor",
			AgentName: "processor-test-log-caps", User: "test", Hostname: "test-host",
			ParentSessionID: parent,
			Timestamp:       time.Now().UTC().Format(time.RFC3339),
		})
		if err == nil {
			t.Fatal("a session_start with a malformed parent_session_id was stored")
		}

		logLine, wantErrPrefix := "parent session lookup failed", `err="session exists `+marker
		if db.Backend == storage.SQLite {
			logLine, wantErrPrefix = "upsert parent stub failed", `err="upsert parent stub `
		} else if !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(parent)) {
			// The returned error quotes the whole id (lower-cased by the
			// writer's id normalisation); the consumer caps it on the line
			// it logs. Pin the premise so the cap below is not vacuous.
			t.Fatalf("Postgres no longer quotes the bad input; the error is %.200s", err.Error())
		}

		lines := logs.linesWith(logLine)
		if len(lines) != 1 {
			t.Fatalf("logged %d %q lines, want 1", len(lines), logLine)
		}
		line := lines[0]
		// The capped id, the capped error and a few short keys.
		const maxLineLen = logcap.MaxID + logcap.MaxErr + 512
		if len(line) > maxLineLen {
			t.Fatalf("the %q line is %d bytes, want at most %d", logLine, len(line), maxLineLen)
		}
		for _, want := range []string{
			"session_id=" + sessionID,
			`parent_session_id="` + marker,
			// The writer's error names the id before the database's text,
			// so the capped error keeps that much of it.
			wantErrPrefix,
			"…(1048576 bytes)",
		} {
			if !strings.Contains(line, want) {
				t.Errorf("the %q line lacks %q: %.300s", logLine, want, line)
			}
		}
	})
}
