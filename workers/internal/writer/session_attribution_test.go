package writer

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// These tests pin when an agent's total_sessions counts a session: once,
// when the session row becomes attributed to the agent, whether the row
// was inserted by the agent's own session_start or written first as a
// parent stub by a sub-agent's session_start.

// racers is how many goroutines start at once in the race tests. Enough
// to keep several statements on the same row in flight together on
// Postgres; on SQLite they queue on the single writer connection, which
// is the serialisation the test then proves correct.
const racers = 12

// raceRounds repeats each race on a fresh session id, so the outcome
// does not rest on a single interleaving of the racers.
const raceRounds = 8

// testAgent upserts an agent row and removes it, after the sessions
// registered with trackSession, when the test ends.
func testAgent(t *testing.T, w *Writer, db *storage.DB, name string) AgentIdentity {
	t.Helper()
	id := AgentIdentity{
		AgentID:    newUUID(t),
		AgentType:  "coding",
		ClientType: "flightdeck_sensor",
		AgentName:  name,
		UserName:   "writer-test",
		Hostname:   "writer-test-host",
	}
	if err := w.UpsertAgent(context.Background(), id); err != nil {
		t.Fatalf("upsert agent: %v", err)
	}
	t.Cleanup(func() {
		if _, err := db.ExecContext(context.Background(),
			`DELETE FROM agents WHERE agent_id = $1`, id.AgentID); err != nil {
			t.Errorf("cleanup agent %s: %v", id.AgentID, err)
		}
	})
	return id
}

// trackSession deletes the session row and its events when the test
// ends. Registered after testAgent, so it runs before the agent's
// cleanup.
func trackSession(t *testing.T, db *storage.DB, sessionID string) {
	t.Helper()
	t.Cleanup(func() {
		for _, q := range []string{
			`DELETE FROM event_content WHERE session_id = $1`,
			`DELETE FROM events WHERE session_id = $1`,
			`DELETE FROM sessions WHERE session_id = $1`,
		} {
			if _, err := db.ExecContext(context.Background(), q, sessionID); err != nil {
				t.Errorf("cleanup session %s: %v", sessionID, err)
			}
		}
	})
}

// startSession runs a session_start the way HandleSessionStart does:
// UpsertSession, then one count for the agent when the row was
// attributed to it.
func startSession(ctx context.Context, w *Writer, sessionID string, id AgentIdentity) (bool, error) {
	attributed, err := w.UpsertSession(
		ctx, sessionID, "writer-test", id.AgentType,
		"writer-test-host", "", "", "active",
		id.AgentID, id.ClientType, id.AgentName,
		nil, "", "", "", "", true, 0, time.Time{},
	)
	if err != nil || !attributed {
		return attributed, err
	}
	return true, w.BumpAgentSessionCount(ctx, id.AgentID)
}

// attributeOnEvent runs the guard's attribution for an event of the
// session the way handleSessionGuard does.
func attributeOnEvent(ctx context.Context, w *Writer, sessionID string, id AgentIdentity) (bool, error) {
	attributed, err := w.AttributeSession(ctx, sessionID, id)
	if err != nil || !attributed {
		return attributed, err
	}
	return true, w.BumpAgentSessionCount(ctx, id.AgentID)
}

func totalSessions(t *testing.T, db *storage.DB, agentID string) int {
	t.Helper()
	var n int
	if err := db.Reader().QueryRowContext(context.Background(),
		`SELECT total_sessions FROM agents WHERE agent_id = $1`, agentID).Scan(&n); err != nil {
		t.Fatalf("read total_sessions: %v", err)
	}
	return n
}

type sessionOwner struct {
	agentID, clientType, agentName, flavor, agentType string
}

func readOwner(t *testing.T, db *storage.DB, sessionID string) sessionOwner {
	t.Helper()
	var o sessionOwner
	if err := db.Reader().QueryRowContext(context.Background(), `
		SELECT COALESCE(CAST(agent_id AS TEXT), ''), COALESCE(client_type, ''),
		       COALESCE(agent_name, ''), flavor, agent_type
		FROM sessions WHERE session_id = $1`, sessionID,
	).Scan(&o.agentID, &o.clientType, &o.agentName, &o.flavor, &o.agentType); err != nil {
		t.Fatalf("read session %s: %v", sessionID, err)
	}
	return o
}

func TestUpsertSession_FreshStartCountsOnce(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		ctx := context.Background()
		agent := testAgent(t, w, db, "fresh-start")
		sessionID := newUUID(t)
		trackSession(t, db, sessionID)

		attributed, err := startSession(ctx, w, sessionID, agent)
		if err != nil {
			t.Fatalf("session_start: %v", err)
		}
		if !attributed {
			t.Error("a session_start that inserts the row must report it attributed")
		}
		if got := totalSessions(t, db, agent.AgentID); got != 1 {
			t.Errorf("total_sessions = %d, want 1", got)
		}
	})
}

func TestUpsertSession_DuplicateStartStaysAtOne(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		ctx := context.Background()
		agent := testAgent(t, w, db, "duplicate-start")
		sessionID := newUUID(t)
		trackSession(t, db, sessionID)

		for i := range 3 {
			attributed, err := startSession(ctx, w, sessionID, agent)
			if err != nil {
				t.Fatalf("session_start %d: %v", i, err)
			}
			if attributed != (i == 0) {
				t.Errorf("delivery %d reported attributed = %v, want %v", i, attributed, i == 0)
			}
		}
		if got := totalSessions(t, db, agent.AgentID); got != 1 {
			t.Errorf("total_sessions = %d after a redelivered session_start, want 1", got)
		}
	})
}

// The bug this file exists for: a sub-agent's session_start processed
// before its parent's writes the parent row as a stub, and the parent's
// own session_start then took the ON CONFLICT path and never counted
// the session, leaving the parent agent at total_sessions 0.
func TestUpsertSession_StubThenRealStartCountsTheParentOnce(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		ctx := context.Background()
		parent := testAgent(t, w, db, "stub-then-start")
		parentSessionID := newUUID(t)
		trackSession(t, db, parentSessionID)

		created, err := w.UpsertParentStub(ctx, parentSessionID, time.Now().UTC())
		if err != nil || !created {
			t.Fatalf("parent stub: created = %v, err = %v", created, err)
		}
		if o := readOwner(t, db, parentSessionID); o.agentID != "" {
			t.Fatalf("a parent stub must belong to no agent, has agent_id %s", o.agentID)
		}

		attributed, err := startSession(ctx, w, parentSessionID, parent)
		if err != nil {
			t.Fatalf("parent session_start: %v", err)
		}
		if !attributed {
			t.Error("the parent's session_start must report the stub it filled as attributed")
		}
		if got := totalSessions(t, db, parent.AgentID); got != 1 {
			t.Errorf("parent total_sessions = %d, want 1", got)
		}
		o := readOwner(t, db, parentSessionID)
		want := sessionOwner{parent.AgentID, parent.ClientType, parent.AgentName, "writer-test", parent.AgentType}
		if o != want {
			t.Errorf("stub after the parent's start = %+v, want %+v", o, want)
		}

		// A redelivery of the parent's start finds the row owned.
		if attributed, err := startSession(ctx, w, parentSessionID, parent); err != nil || attributed {
			t.Errorf("redelivered parent start: attributed = %v, err = %v; want false, nil", attributed, err)
		}
		if got := totalSessions(t, db, parent.AgentID); got != 1 {
			t.Errorf("parent total_sessions = %d after a redelivery, want 1", got)
		}
	})
}

func TestUpsertParentStub_AfterTheParentExistsChangesNothing(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		ctx := context.Background()
		parent := testAgent(t, w, db, "start-then-stub")
		parentSessionID := newUUID(t)
		trackSession(t, db, parentSessionID)

		if _, err := startSession(ctx, w, parentSessionID, parent); err != nil {
			t.Fatalf("parent session_start: %v", err)
		}
		before := readOwner(t, db, parentSessionID)

		created, err := w.UpsertParentStub(ctx, parentSessionID, time.Now().UTC())
		if err != nil {
			t.Fatalf("parent stub: %v", err)
		}
		if created {
			t.Error("a stub for an existing parent must not be created")
		}
		if after := readOwner(t, db, parentSessionID); after != before {
			t.Errorf("the stub changed the parent row: %+v -> %+v", before, after)
		}
		if got := totalSessions(t, db, parent.AgentID); got != 1 {
			t.Errorf("parent total_sessions = %d, want 1", got)
		}
	})
}

// A stub whose session_start never arrives is attributed by the first
// other event of the session; a later session_start finds it owned.
func TestAttributeSession_ClaimsAStubOnce(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		ctx := context.Background()
		parent := testAgent(t, w, db, "attribute-stub")
		parentSessionID := newUUID(t)
		trackSession(t, db, parentSessionID)
		if _, err := w.UpsertParentStub(ctx, parentSessionID, time.Now().UTC()); err != nil {
			t.Fatalf("parent stub: %v", err)
		}

		for i := range 2 {
			attributed, err := attributeOnEvent(ctx, w, parentSessionID, parent)
			if err != nil {
				t.Fatalf("attribute %d: %v", i, err)
			}
			if attributed != (i == 0) {
				t.Errorf("event %d reported attributed = %v, want %v", i, attributed, i == 0)
			}
		}
		o := readOwner(t, db, parentSessionID)
		if o.agentID != parent.AgentID || o.clientType != parent.ClientType || o.agentName != parent.AgentName {
			t.Errorf("attributed stub = %+v, want the parent's identity", o)
		}
		if attributed, err := startSession(ctx, w, parentSessionID, parent); err != nil || attributed {
			t.Errorf("late parent start: attributed = %v, err = %v; want false, nil", attributed, err)
		}
		if got := totalSessions(t, db, parent.AgentID); got != 1 {
			t.Errorf("parent total_sessions = %d, want 1", got)
		}
	})
}

// AttributeSession never takes a row another agent owns.
func TestAttributeSession_LeavesAnOwnedRowAlone(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		ctx := context.Background()
		owner := testAgent(t, w, db, "owner")
		other := testAgent(t, w, db, "other")
		sessionID := newUUID(t)
		trackSession(t, db, sessionID)
		if _, err := startSession(ctx, w, sessionID, owner); err != nil {
			t.Fatalf("session_start: %v", err)
		}
		if attributed, err := attributeOnEvent(ctx, w, sessionID, other); err != nil || attributed {
			t.Errorf("attribute an owned row: attributed = %v, err = %v; want false, nil", attributed, err)
		}
		if o := readOwner(t, db, sessionID); o.agentID != owner.AgentID {
			t.Errorf("agent_id = %s, want the owner %s", o.agentID, owner.AgentID)
		}
		if got := totalSessions(t, db, other.AgentID); got != 0 {
			t.Errorf("other agent total_sessions = %d, want 0", got)
		}
	})
}

// race runs each fn in its own goroutine, released together, and
// returns how many reported attributed.
func race(t *testing.T, fns []func(context.Context) (bool, error)) int {
	t.Helper()
	ctx := context.Background()
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		claimed int
	)
	release := make(chan struct{})
	for _, fn := range fns {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-release
			attributed, err := fn(ctx)
			if err != nil {
				t.Errorf("racer: %v", err)
				return
			}
			if attributed {
				mu.Lock()
				claimed++
				mu.Unlock()
			}
		}()
	}
	close(release)
	wg.Wait()
	return claimed
}

func TestUpsertSession_ConcurrentStartsCountOnce(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		agent := testAgent(t, w, db, "concurrent-starts")
		for round := range raceRounds {
			sessionID := newUUID(t)
			trackSession(t, db, sessionID)
			fns := make([]func(context.Context) (bool, error), racers)
			for i := range fns {
				fns[i] = func(ctx context.Context) (bool, error) { return startSession(ctx, w, sessionID, agent) }
			}
			if claimed := race(t, fns); claimed != 1 {
				t.Errorf("round %d: %d of %d concurrent starts reported attributed, want 1", round, claimed, racers)
			}
		}
		if got := totalSessions(t, db, agent.AgentID); got != raceRounds {
			t.Errorf("total_sessions = %d for %d sessions, want %d", got, raceRounds, raceRounds)
		}
	})
}

// Parent stubs from several children race the parent's own starts (and
// their redeliveries) on a missing row: whichever writes the row first,
// the parent counts each session once.
func TestUpsertSession_StubsRacingTheParentStartCountOnce(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		parent := testAgent(t, w, db, "stub-race")
		for round := range raceRounds {
			parentSessionID := newUUID(t)
			trackSession(t, db, parentSessionID)
			fns := make([]func(context.Context) (bool, error), racers)
			for i := range fns {
				if i%2 == 0 {
					fns[i] = func(ctx context.Context) (bool, error) {
						_, err := w.UpsertParentStub(ctx, parentSessionID, time.Now().UTC())
						return false, err
					}
					continue
				}
				fns[i] = func(ctx context.Context) (bool, error) { return startSession(ctx, w, parentSessionID, parent) }
			}
			if claimed := race(t, fns); claimed != 1 {
				t.Errorf("round %d: %d parent starts reported attributed, want 1", round, claimed)
			}
			if o := readOwner(t, db, parentSessionID); o.agentID != parent.AgentID {
				t.Errorf("round %d: parent row agent_id = %q, want %s", round, o.agentID, parent.AgentID)
			}
		}
		if got := totalSessions(t, db, parent.AgentID); got != raceRounds {
			t.Errorf("parent total_sessions = %d for %d sessions, want %d", got, raceRounds, raceRounds)
		}
	})
}

// The parent's start and its other events race to claim an existing
// stub: exactly one of them attributes it.
func TestAttributeSession_RacingTheParentStartCountsOnce(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		parent := testAgent(t, w, db, "claim-race")
		for round := range raceRounds {
			parentSessionID := newUUID(t)
			trackSession(t, db, parentSessionID)
			if _, err := w.UpsertParentStub(context.Background(), parentSessionID, time.Now().UTC()); err != nil {
				t.Fatalf("parent stub: %v", err)
			}
			fns := make([]func(context.Context) (bool, error), racers)
			for i := range fns {
				if i%2 == 0 {
					fns[i] = func(ctx context.Context) (bool, error) { return attributeOnEvent(ctx, w, parentSessionID, parent) }
					continue
				}
				fns[i] = func(ctx context.Context) (bool, error) { return startSession(ctx, w, parentSessionID, parent) }
			}
			if claimed := race(t, fns); claimed != 1 {
				t.Errorf("round %d: %d writers attributed the stub, want 1", round, claimed)
			}
		}
		if got := totalSessions(t, db, parent.AgentID); got != raceRounds {
			t.Errorf("parent total_sessions = %d for %d sessions, want %d", got, raceRounds, raceRounds)
		}
	})
}

// An id in another spelling names the same row: an upper-case
// session_start and a lower-case call land on one session on both
// backends.
func TestUpsertSession_UpperCaseIDNamesTheSameRow(t *testing.T) {
	each(t, func(t *testing.T, db *storage.DB) {
		w, _ := newTestWriter(db)
		ctx := context.Background()
		agent := testAgent(t, w, db, "upper-case")
		lower := newUUID(t)
		trackSession(t, db, lower)
		upper := "ABCDEF01-2345-4678-89AB-CDEF01234567"
		if upper = upper[:len(upper)-len(lower[len(lower)-4:])] + lower[len(lower)-4:]; upper == "" {
			t.Fatal("unreachable")
		}
		// A distinct id for this test: the canonical form of upper.
		trackSession(t, db, canonicalUUID(upper))
		if _, err := startSession(ctx, w, upper, agent); err != nil {
			t.Fatalf("upper-case session_start: %v", err)
		}
		if err := w.UpdateTokensUsed(ctx, canonicalUUID(upper), 7); err != nil {
			t.Fatalf("lower-case update: %v", err)
		}
		var tokens int
		if err := db.Reader().QueryRowContext(ctx, `SELECT tokens_used FROM sessions WHERE session_id = $1`, canonicalUUID(upper)).Scan(&tokens); err != nil {
			t.Fatalf("read the row by its canonical id: %v", err)
		}
		if tokens != 7 {
			t.Errorf("tokens_used = %d, want 7 on the one row", tokens)
		}
		if exists, err := w.SessionExists(ctx, upper); err != nil || !exists {
			t.Errorf("SessionExists(upper) = %v, %v; want true", exists, err)
		}
	})
}
