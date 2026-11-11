package directive

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

func randomUUID(t *testing.T) string {
	t.Helper()
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// seedSession stores a session of flavor and removes it when the test
// ends.
func seedSession(t *testing.T, db *storage.DB, id, flavor string) {
	t.Helper()
	if _, err := db.ExecContext(context.Background(), `
		INSERT INTO sessions (session_id, flavor, agent_type, state)
		VALUES ($1, $2, 'coding', 'active')`, id, flavor); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	t.Cleanup(func() {
		_, _ = db.ExecContext(context.Background(), `DELETE FROM directives WHERE session_id = $1 OR flavor = $2`, id, flavor)
		_, _ = db.ExecContext(context.Background(), `DELETE FROM sessions WHERE session_id = $1`, id)
	})
}

// seedDirective stores a directive addressed to the session (or, with an
// empty id, to the flavor), issued at issuedAt, and returns its id.
func seedDirective(t *testing.T, db *storage.DB, sessionID, flavor, action string, issuedAt time.Time, payload string) string {
	t.Helper()
	var session *string
	if sessionID != "" {
		session = &sessionID
	}
	var raw *string
	if payload != "" {
		raw = &payload
	}
	var id string
	if err := db.QueryRowContext(context.Background(), `
		INSERT INTO directives (session_id, flavor, action, reason, grace_period_ms, issued_at, degrade_to, payload)
		VALUES ($1, $2, $3, 'test', 1500, $4, $5, $6)
		RETURNING CAST(id AS TEXT)`,
		session, flavor, action, issuedAt, nil, raw).Scan(&id); err != nil {
		t.Fatalf("seed directive: %v", err)
	}
	return id
}

// LookupPending takes the oldest undelivered directive addressed to the
// session or to its flavor, marks it delivered so a second lookup does
// not return it, carries the payload through, leaves another session's
// directive of the same flavor alone, and answers nil when nothing is
// pending; the session id may come in upper case.
func TestLookupPendingOnBothBackends(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		s := NewStore(db)
		flavor := "directive-test-" + randomUUID(t)[:8]
		mine, other := randomUUID(t), randomUUID(t)
		seedSession(t, db, mine, flavor)
		seedSession(t, db, other, flavor)

		if d, err := s.LookupPending(ctx, mine); err != nil || d != nil {
			t.Fatalf("LookupPending with nothing pending = %+v, %v; want nil, nil", d, err)
		}

		base := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
		custom := seedDirective(t, db, mine, flavor, "custom", base.Add(2*time.Minute),
			`{"directive_name":"reload","fingerprint":"abc","parameters":{"level":2}}`)
		shutdown := seedDirective(t, db, mine, flavor, "shutdown", base, "")
		forFlavor := seedDirective(t, db, "", flavor, "degrade", base.Add(time.Minute), "")
		theirs := seedDirective(t, db, other, flavor, "shutdown", base.Add(-time.Hour), "")

		var got []string
		for range 3 {
			d, err := s.LookupPending(ctx, strings.ToUpper(mine))
			if err != nil {
				t.Fatal(err)
			}
			if d == nil {
				t.Fatalf("LookupPending returned nil after %d directives", len(got))
			}
			got = append(got, d.ID)
			switch d.ID {
			case shutdown:
				if d.Action != "shutdown" || d.Reason != "test" || d.GracePeriodMs != 1500 || d.Payload != nil {
					t.Errorf("shutdown directive = %+v", d)
				}
			case custom:
				var payload map[string]any
				if d.Payload == nil || json.Unmarshal(*d.Payload, &payload) != nil || payload["directive_name"] != "reload" {
					t.Errorf("custom directive payload = %v", d.Payload)
				}
			}
		}
		if want := []string{shutdown, forFlavor, custom}; strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("delivered %v, want the oldest first: %v", got, want)
		}
		if d, err := s.LookupPending(ctx, mine); err != nil || d != nil {
			t.Fatalf("LookupPending after all were delivered = %+v, %v; want nil", d, err)
		}

		// The other session's directive was left for its own lookup.
		d, err := s.LookupPending(ctx, other)
		if err != nil || d == nil || d.ID != theirs {
			t.Fatalf("the other session's lookup = %+v, %v; want its own directive %s", d, err, theirs)
		}
		var delivered int
		if err := db.Reader().QueryRowContext(ctx,
			`SELECT count(*) FROM directives WHERE flavor = $1 AND delivered_at IS NOT NULL`, flavor).Scan(&delivered); err != nil {
			t.Fatal(err)
		}
		if delivered != 4 {
			t.Fatalf("%d directives marked delivered, want all 4", delivered)
		}
	})
}

// Many lookups for one session race for one pending directive: exactly
// one takes it on both backends. On Postgres the lookups that waited on
// the row lock re-check the updated row under READ COMMITTED and find
// it delivered; on SQLite the one writer runs them in turn.
func TestLookupPendingConcurrentLookupsDeliverOnce(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		s := NewStore(db)
		flavor := "directive-race-" + randomUUID(t)[:8]
		mine := randomUUID(t)
		seedSession(t, db, mine, flavor)
		const rounds, lookups = 5, 8
		for range rounds {
			id := seedDirective(t, db, mine, flavor, "shutdown", time.Now().UTC(), "")
			start := make(chan struct{})
			got := make(chan *Directive, lookups)
			var wg sync.WaitGroup
			for range lookups {
				wg.Add(1)
				go func() {
					defer wg.Done()
					<-start
					d, err := s.LookupPending(ctx, mine)
					if err != nil {
						t.Errorf("LookupPending: %v", err)
					}
					got <- d
				}()
			}
			close(start)
			wg.Wait()
			close(got)
			var delivered []string
			for d := range got {
				if d != nil {
					delivered = append(delivered, d.ID)
				}
			}
			if len(delivered) != 1 || delivered[0] != id {
				t.Fatalf("%d lookups delivered %v, want exactly one delivery of %s", lookups, delivered, id)
			}
		}
	})
}
