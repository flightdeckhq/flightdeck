package store

import (
	"context"
	"sort"
	"testing"
	"time"
)

// tiedEventsCount is how many events share one timestamp in the
// ordering tests: more than any page size the tests use, so every page
// boundary they cross falls inside the tie.
const tiedEventsCount = 7

// seedTiedEvents stores a session whose events are one older event,
// tiedEventsCount events sharing a single timestamp, and one newer
// event. The tied events are inserted in descending id order, so an
// order without the id tiebreaker (physical order) differs from the
// contract. Returns the session id, the event ids in (occurred_at, id)
// ascending order, and the window bounds. The session and its events
// are removed when the test ends.
func seedTiedEvents(t *testing.T, s *Store) (sessionID string, ordered []string, from, to time.Time) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	sessionID = randomUUID(t)
	flavor := "test-events-order-" + sessionID[:8]
	if _, err := s.pool.Exec(ctx, `
		INSERT INTO sessions (session_id, flavor, agent_type, state, started_at, last_seen_at)
		VALUES ($1::uuid, $2, 'coding', 'closed', $3, $3)`,
		sessionID, flavor, now.Add(-5*time.Minute)); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		if _, err := s.pool.Exec(ctx, `DELETE FROM events WHERE session_id = $1::uuid`, sessionID); err != nil {
			t.Errorf("cleanup events: %v", err)
		}
		if _, err := s.pool.Exec(ctx, `DELETE FROM sessions WHERE session_id = $1::uuid`, sessionID); err != nil {
			t.Errorf("cleanup session: %v", err)
		}
	})

	insert := func(id string, at time.Time) {
		if _, err := s.pool.Exec(ctx, `
			INSERT INTO events (id, session_id, flavor, event_type, occurred_at)
			VALUES ($1::uuid, $2::uuid, $3, 'tool_call', $4)`,
			id, sessionID, flavor, at); err != nil {
			t.Fatalf("seed event: %v", err)
		}
	}

	tie := now.Add(-2 * time.Minute)
	tied := make([]string, tiedEventsCount)
	for i := range tied {
		tied[i] = randomUUID(t)
	}
	// Lowercase canonical UUID strings sort as Postgres orders uuids.
	sort.Strings(tied)

	older, newer := randomUUID(t), randomUUID(t)
	insert(older, tie.Add(-time.Minute))
	for i := len(tied) - 1; i >= 0; i-- {
		insert(tied[i], tie)
	}
	insert(newer, tie.Add(time.Minute))

	ordered = append(append([]string{older}, tied...), newer)
	return sessionID, ordered, now.Add(-time.Hour), now
}

func reversed(ids []string) []string {
	out := make([]string, len(ids))
	for i, id := range ids {
		out[len(ids)-1-i] = id
	}
	return out
}

func idsOf(events []Event) []string {
	ids := make([]string, len(events))
	for i, e := range events {
		ids[i] = e.ID
	}
	return ids
}

func assertIDs(t *testing.T, what string, got, want []string) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: got %d events %v, want %d %v", what, len(got), got, len(want), want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("%s: position %d is %s, want %s\n got  %v\n want %v", what, i, got[i], want[i], got, want)
		}
	}
}

// Offset pages, in either direction, concatenate to the whole session
// in (occurred_at, id) order: no event that shares a timestamp is
// skipped or repeated at a page boundary.
func TestGetEvents_OffsetPagesFollowOccurredAtThenID(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	sessionID, ordered, from, to := seedTiedEvents(t, s)

	for _, tc := range []struct {
		order string
		limit int
		want  []string
	}{
		{"asc", 2, ordered},
		{"desc", 3, reversed(ordered)},
	} {
		var got []string
		for offset := 0; ; offset += tc.limit {
			resp, err := s.GetEvents(context.Background(), EventsParams{
				From: from, To: to, SessionID: sessionID,
				Order: tc.order, Limit: tc.limit, Offset: offset,
			})
			if err != nil {
				t.Fatalf("GetEvents(%s, offset %d): %v", tc.order, offset, err)
			}
			got = append(got, idsOf(resp.Events)...)
			if !resp.HasMore || len(resp.Events) == 0 {
				break
			}
		}
		assertIDs(t, tc.order+" offset pages", got, tc.want)
	}
}

// The (before, before_id) keyset walks newest-first through the tie,
// one row past the cursor each time, and reaches every event once.
// before alone keeps its meaning: strictly older timestamps only.
func TestGetEvents_KeysetResumesAfterTheCursorRow(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	sessionID, ordered, from, to := seedTiedEvents(t, s)
	ctx := context.Background()

	const pageSize = 2
	page, err := s.GetEvents(ctx, EventsParams{
		From: from, To: to, SessionID: sessionID, Order: "desc", Limit: pageSize,
	})
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	got := idsOf(page.Events)
	for page.HasMore && len(page.Events) > 0 {
		cursor := page.Events[len(page.Events)-1]
		page, err = s.GetEvents(ctx, EventsParams{
			From: time.Unix(0, 0).UTC(), To: to, SessionID: sessionID, Order: "desc", Limit: pageSize,
			Before: cursor.OccurredAt, BeforeID: cursor.ID,
		})
		if err != nil {
			t.Fatalf("page before %s: %v", cursor.ID, err)
		}
		got = append(got, idsOf(page.Events)...)
	}
	assertIDs(t, "keyset pages", got, reversed(ordered))

	// A cursor in the middle of the tie: the tied rows with smaller ids
	// and the older row follow it, nothing else.
	mid := ordered[4]
	var midAt time.Time
	if err := s.pool.QueryRow(ctx, `SELECT occurred_at FROM events WHERE id = $1::uuid`, mid).Scan(&midAt); err != nil {
		t.Fatalf("read cursor row: %v", err)
	}
	rest, err := s.GetEvents(ctx, EventsParams{
		From: time.Unix(0, 0).UTC(), To: to, SessionID: sessionID, Order: "desc", Limit: 100,
		Before: midAt, BeforeID: mid,
	})
	if err != nil {
		t.Fatalf("keyset from the middle of the tie: %v", err)
	}
	assertIDs(t, "rows before the mid-tie cursor", idsOf(rest.Events), reversed(ordered[:4]))
	if rest.Total != 4 {
		t.Errorf("total = %d, want 4", rest.Total)
	}

	older, err := s.GetEvents(ctx, EventsParams{
		From: time.Unix(0, 0).UTC(), To: to, SessionID: sessionID, Order: "desc", Limit: 100,
		Before: midAt,
	})
	if err != nil {
		t.Fatalf("before without before_id: %v", err)
	}
	assertIDs(t, "before alone", idsOf(older.Events), ordered[:1])
}

// The session detail's capped slice is the newest N in the same order,
// returned ascending, and ends on the row the drawer's keyset resumes
// from; the uncapped list is the whole session in order.
func TestGetSessionEvents_OrdersTiesByID(t *testing.T) {
	s, cleanup := newTestStore(t)
	defer cleanup()
	sessionID, ordered, _, _ := seedTiedEvents(t, s)
	ctx := context.Background()

	all, err := s.GetSessionEvents(ctx, sessionID, 0)
	if err != nil {
		t.Fatalf("GetSessionEvents(all): %v", err)
	}
	assertIDs(t, "full history", idsOf(all), ordered)

	const capped = 4
	newest, err := s.GetSessionEvents(ctx, sessionID, capped)
	if err != nil {
		t.Fatalf("GetSessionEvents(%d): %v", capped, err)
	}
	assertIDs(t, "newest slice", idsOf(newest), ordered[len(ordered)-capped:])
}
