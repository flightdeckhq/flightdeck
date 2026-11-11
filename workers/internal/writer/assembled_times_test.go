package writer

import (
	"context"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// These tests pin how a session row is dated. A session assembled from
// an OpenTelemetry trace (its session_start context carries
// otel_trace_id) is published after the run it describes, so its
// session_start and session_end date started_at and ended_at, each
// capped at the database's clock; every other session is dated by the
// clock when the worker writes the start and the end.

// assembledContext is the context of an assembled session's start.
var assembledContext = []byte(`{"telemetry":"otlp","otel_trace_id":"4bf92f3577b34da6a3ce929d0e0e4736"}`)

// sensorContext is the context of any other client's start.
var sensorContext = []byte(`{"os":"Linux","python_version":"3.12"}`)

// rowTimes is a session row's dates.
type rowTimes struct {
	startedAt, lastSeenAt time.Time
	endedAt               *time.Time
}

func readTimes(t *testing.T, db *storage.DB, sessionID string) rowTimes {
	t.Helper()
	var r rowTimes
	if err := db.Reader().QueryRowContext(context.Background(),
		`SELECT started_at, last_seen_at, ended_at FROM sessions WHERE session_id = $1`, sessionID,
	).Scan(&r.startedAt, &r.lastSeenAt, &r.endedAt); err != nil {
		t.Fatalf("read session %s: %v", sessionID, err)
	}
	return r
}

// upsertStart runs a session_start's UpsertSession with the given
// context, stream sequence and timestamp.
func upsertStart(t *testing.T, w *Writer, sessionID string, id AgentIdentity, contextJSON []byte, seq uint64, ts time.Time) {
	t.Helper()
	if _, err := w.UpsertSession(
		context.Background(), sessionID, "times-test", id.AgentType,
		"times-test-host", "", "", "active",
		id.AgentID, id.ClientType, id.AgentName,
		contextJSON, "", "", "", "", false, seq, ts,
	); err != nil {
		t.Fatalf("upsert session %s: %v", sessionID, err)
	}
}

// settle runs SettleSessionEnd and fails the test on an error.
func settle(t *testing.T, w *Writer, sessionID string, seq uint64, ts time.Time) (applied, closedNow bool) {
	t.Helper()
	applied, closedNow, err := w.SettleSessionEnd(context.Background(), sessionID, seq, ts)
	if err != nil {
		t.Fatalf("settle session end %s: %v", sessionID, err)
	}
	return applied, closedNow
}

// reattach reopens a closed row the way the ingestion API's Attach does
// for a re-attaching session_start, before the worker sees the start.
func reattach(t *testing.T, db *storage.DB, sessionID string) {
	t.Helper()
	if _, err := db.ExecContext(context.Background(), `
		UPDATE sessions SET state = 'active', ended_at = NULL, closed_seq = NULL
		WHERE session_id = $1`, sessionID); err != nil {
		t.Fatalf("reattach %s: %v", sessionID, err)
	}
}

func newTimesSession(t *testing.T, db *storage.DB) (*Writer, AgentIdentity, string) {
	t.Helper()
	w, _ := newTestWriter(db)
	id := testAgent(t, w, db, "times-test")
	sessionID := newUUID(t)
	trackSession(t, db, sessionID)
	return w, id, sessionID
}

func TestUpsertSession_AssembledStartThatInsertsTheRowSetsItsTimestamp(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, id, sessionID := newTimesSession(t, db)
		startedAt := ago(10 * time.Minute)

		before := dbNow(t, db)
		upsertStart(t, w, sessionID, id, assembledContext, 10, startedAt)
		after := dbNow(t, db)

		r := readTimes(t, db, sessionID)
		equalTime(t, "started_at", r.startedAt, startedAt)
		within(t, "last_seen_at", r.lastSeenAt, before, after)
	})
}

func TestUpsertSession_AssembledStartIsCappedAtTheDatabasesClock(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, id, sessionID := newTimesSession(t, db)

		before := dbNow(t, db)
		upsertStart(t, w, sessionID, id, assembledContext, 10, time.Now().Add(3*time.Minute))
		after := dbNow(t, db)

		within(t, "started_at of a start dated ahead of the clock", readTimes(t, db, sessionID).startedAt, before, after)
	})
}

func TestUpsertSession_AssembledStartWithoutATimestampTakesTheClock(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, id, sessionID := newTimesSession(t, db)

		before := dbNow(t, db)
		upsertStart(t, w, sessionID, id, assembledContext, 10, time.Time{})
		after := dbNow(t, db)

		within(t, "started_at of a start whose timestamp did not parse", readTimes(t, db, sessionID).startedAt, before, after)
	})
}

func TestUpsertSession_AssembledStartReplacesAParentStubsPlaceholder(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, id, sessionID := newTimesSession(t, db)
		childStartedAt := ago(5 * time.Minute)
		if _, err := w.UpsertParentStub(context.Background(), sessionID, childStartedAt); err != nil {
			t.Fatalf("parent stub: %v", err)
		}
		startedAt := ago(10 * time.Minute)

		before := dbNow(t, db)
		upsertStart(t, w, sessionID, id, assembledContext, 10, startedAt)
		after := dbNow(t, db)

		r := readTimes(t, db, sessionID)
		equalTime(t, "started_at of a claimed stub", r.startedAt, startedAt)
		within(t, "last_seen_at", r.lastSeenAt, before, after)
	})
}

func TestUpsertSession_AssembledStartReplacesALazyRowsPlaceholder(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		for _, tc := range []struct {
			name string
			// lazyContext is the context a later event wrote on the lazy row
			// (nil: none), which does not make the row started.
			lazyContext []byte
		}{
			{"no context", nil},
			{"context from an event", assembledContext},
		} {
			t.Run(tc.name, func(t *testing.T) {
				w, id, sessionID := newTimesSession(t, db)
				ctx := context.Background()
				if _, err := w.ReviveOrCreateSession(ctx, sessionID, "times-test", id.AgentType,
					"", "", "", id, ago(5*time.Minute), "", ""); err != nil {
					t.Fatalf("lazy create: %v", err)
				}
				if tc.lazyContext != nil {
					if err := w.UpgradeSessionContext(ctx, sessionID, tc.lazyContext); err != nil {
						t.Fatalf("upgrade context: %v", err)
					}
				}
				startedAt := ago(10 * time.Minute)
				upsertStart(t, w, sessionID, id, assembledContext, 10, startedAt)
				equalTime(t, "started_at of a lazily created row", readTimes(t, db, sessionID).startedAt, startedAt)
			})
		}
	})
}

// A re-attaching start (dated just before the late events it precedes)
// keeps the run's original start; the re-attaching end dates the close,
// at the original end or, when that is outside the validation window,
// just after the latest late event.
func TestSessionTimes_ReattachmentKeepsTheStartAndTakesTheEnd(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		for _, tc := range []struct {
			name string
			end  func(originalEnd, late time.Time) time.Time
		}{
			{"dated at the original end", func(originalEnd, _ time.Time) time.Time { return originalEnd }},
			{"dated after the latest late event", func(_, late time.Time) time.Time { return late.Add(time.Millisecond) }},
		} {
			t.Run(tc.name, func(t *testing.T) {
				w, id, sessionID := newTimesSession(t, db)
				startedAt := ago(30 * time.Minute)
				originalEnd := ago(20 * time.Minute)
				late := ago(time.Minute)

				upsertStart(t, w, sessionID, id, assembledContext, 10, startedAt)
				if applied, closedNow := settle(t, w, sessionID, 20, originalEnd); !applied || !closedNow {
					t.Fatalf("first end: applied=%v closedNow=%v, want both", applied, closedNow)
				}
				reattach(t, db, sessionID)
				upsertStart(t, w, sessionID, id, assembledContext, 30, late.Add(-time.Millisecond))
				r := readTimes(t, db, sessionID)
				equalTime(t, "started_at after the re-attaching start", r.startedAt, startedAt)
				if r.endedAt != nil {
					t.Fatalf("ended_at after the re-attaching start = %s, want NULL", r.endedAt)
				}

				endedAt := tc.end(originalEnd, late)
				if applied, closedNow := settle(t, w, sessionID, 40, endedAt); !applied || !closedNow {
					t.Fatalf("re-attaching end: applied=%v closedNow=%v, want both", applied, closedNow)
				}
				r = readTimes(t, db, sessionID)
				equalTime(t, "started_at after the re-attaching end", r.startedAt, startedAt)
				if r.endedAt == nil {
					t.Fatal("ended_at after the re-attaching end is NULL")
				}
				equalTime(t, "ended_at", *r.endedAt, endedAt)
			})
		}
	})
}

// The close is told from a duplicate by the row's prior state, not by
// its ended_at: an assembled end's date is never the clock, and a later
// end of the same session can carry the date already stored.
func TestSettleSessionEnd_AssembledEndReportsTheCloseOnce(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, id, sessionID := newTimesSession(t, db)
		endedAt := ago(5 * time.Minute)
		upsertStart(t, w, sessionID, id, assembledContext, 10, ago(10*time.Minute))

		before := dbNow(t, db)
		if applied, closedNow := settle(t, w, sessionID, 20, endedAt); !applied || !closedNow {
			t.Fatalf("end: applied=%v closedNow=%v, want both", applied, closedNow)
		}
		after := dbNow(t, db)
		r := readTimes(t, db, sessionID)
		if r.endedAt == nil {
			t.Fatal("ended_at is NULL")
		}
		equalTime(t, "ended_at", *r.endedAt, endedAt)
		within(t, "last_seen_at", r.lastSeenAt, before, after)

		// A later end carrying the same date takes its greater sequence and
		// closes nothing.
		if applied, closedNow := settle(t, w, sessionID, 30, endedAt); !applied || closedNow {
			t.Fatalf("later end on the closed row: applied=%v closedNow=%v, want true and false", applied, closedNow)
		}
		// An earlier end matches nothing.
		if applied, _ := settle(t, w, sessionID, 25, endedAt); applied {
			t.Fatal("an end below closed_seq must not match")
		}
		// A missing row matches nothing and is not an error.
		if applied, _ := settle(t, w, newUUID(t), 25, endedAt); applied {
			t.Fatal("a missing row must not match")
		}
		r2 := readTimes(t, db, sessionID)
		equalTime(t, "ended_at after the duplicates", *r2.endedAt, endedAt)
		equalTime(t, "last_seen_at after the duplicates", r2.lastSeenAt, r.lastSeenAt)
		var closedSeq int64
		if err := db.Reader().QueryRowContext(context.Background(), `SELECT closed_seq FROM sessions WHERE session_id = $1`, sessionID).Scan(&closedSeq); err != nil {
			t.Fatal(err)
		}
		if closedSeq != 30 {
			t.Errorf("closed_seq = %d, want the later end's 30", closedSeq)
		}
	})
}

func TestSettleSessionEnd_AssembledEndIsCappedAtTheDatabasesClock(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, id, sessionID := newTimesSession(t, db)
		upsertStart(t, w, sessionID, id, assembledContext, 10, ago(10*time.Minute))

		before := dbNow(t, db)
		settle(t, w, sessionID, 20, time.Now().Add(3*time.Minute))
		after := dbNow(t, db)

		within(t, "ended_at of an end dated ahead of the clock", *readTimes(t, db, sessionID).endedAt, before, after)
	})
}

// Every session without otel_trace_id is dated as before: by the
// clock at its start and its end, whatever the events' own timestamps,
// and a stub or lazily created row keeps its placeholder.
func TestSessionTimes_OtherSessionsKeepTheDatabasesClock(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		for _, tc := range []struct {
			name        string
			contextJSON []byte
		}{
			{"no context", nil},
			{"sensor context", sensorContext},
		} {
			t.Run(tc.name+"/insert and end", func(t *testing.T) {
				w, id, sessionID := newTimesSession(t, db)

				before := dbNow(t, db)
				upsertStart(t, w, sessionID, id, tc.contextJSON, 10, ago(10*time.Minute))
				after := dbNow(t, db)
				within(t, "started_at", readTimes(t, db, sessionID).startedAt, before, after)

				before = dbNow(t, db)
				if applied, closedNow := settle(t, w, sessionID, 20, ago(5*time.Minute)); !applied || !closedNow {
					t.Fatalf("end: applied=%v closedNow=%v, want both", applied, closedNow)
				}
				after = dbNow(t, db)
				within(t, "ended_at", *readTimes(t, db, sessionID).endedAt, before, after)
				if applied, closedNow := settle(t, w, sessionID, 30, ago(5*time.Minute)); !applied || closedNow {
					t.Fatalf("later end: applied=%v closedNow=%v, want true and false", applied, closedNow)
				}
			})
			t.Run(tc.name+"/stub", func(t *testing.T) {
				w, id, sessionID := newTimesSession(t, db)
				placeholder := ago(5 * time.Minute)
				if _, err := w.UpsertParentStub(context.Background(), sessionID, placeholder); err != nil {
					t.Fatalf("parent stub: %v", err)
				}
				upsertStart(t, w, sessionID, id, tc.contextJSON, 10, ago(10*time.Minute))
				equalTime(t, "started_at of a claimed stub", readTimes(t, db, sessionID).startedAt, placeholder)
			})
			t.Run(tc.name+"/lazy row", func(t *testing.T) {
				w, id, sessionID := newTimesSession(t, db)
				placeholder := ago(5 * time.Minute)
				if _, err := w.ReviveOrCreateSession(context.Background(), sessionID, "times-test", id.AgentType,
					"", "", "", id, placeholder, "", ""); err != nil {
					t.Fatalf("lazy create: %v", err)
				}
				upsertStart(t, w, sessionID, id, tc.contextJSON, 10, ago(10*time.Minute))
				equalTime(t, "started_at of a lazily created row", readTimes(t, db, sessionID).startedAt, placeholder)
			})
		}
	})
}

// A closed row stays closed for a session_start published before the
// end that closed it, and is revived by one published after it (or
// with an unknown sequence); the sequences are compared as stored.
func TestUpsertSession_ClosedRowRevivesOnlyForALaterStart(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		for _, tc := range []struct {
			name     string
			startSeq uint64
			want     string
		}{
			{"start before the end", 15, "closed"},
			{"start after the end", 25, "active"},
			{"unknown sequence", 0, "active"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				w, id, sessionID := newTimesSession(t, db)
				upsertStart(t, w, sessionID, id, sensorContext, 10, time.Time{})
				if applied, closedNow := settle(t, w, sessionID, 20, time.Time{}); !applied || !closedNow {
					t.Fatalf("end: applied=%v closedNow=%v", applied, closedNow)
				}
				upsertStart(t, w, sessionID, id, sensorContext, tc.startSeq, time.Time{})
				var state string
				var startSeq *int64
				if err := db.Reader().QueryRowContext(context.Background(),
					`SELECT state, start_seq FROM sessions WHERE session_id = $1`, sessionID).Scan(&state, &startSeq); err != nil {
					t.Fatal(err)
				}
				if state != tc.want {
					t.Errorf("state = %q, want %q", state, tc.want)
				}
				wantSeq := int64(max(10, tc.startSeq))
				if startSeq == nil || *startSeq != wantSeq {
					t.Errorf("start_seq = %v, want the greater of the stored and the start's, %d", startSeq, wantSeq)
				}
			})
		}
	})
}
