package store

import (
	"context"
	"net/url"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// Analytics buckets are UTC dates whatever the database session's time
// zone. On Postgres a bare CAST of a timestamptz to DATE reads the
// session TimeZone, so a server west of UTC would put every bucket a
// day early; the test connects with TimeZone=America/New_York and
// checks that a 03:00Z event (22:00 the previous evening in New York)
// still buckets on its UTC day, week and hour.
func TestQueryAnalytics_BucketsAreUTCDatesUnderAnyTimeZone(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		s := New(db, storage.NewBus(db))
		if db.Backend == storage.Postgres {
			// A second connection to the same database with a session
			// zone far from UTC; SQLite has no session zone.
			u, err := url.Parse(storagetest.PostgresURL(t))
			if err != nil {
				t.Fatal(err)
			}
			q := u.Query()
			q.Set("TimeZone", "America/New_York")
			u.RawQuery = q.Encode()
			tzDB, err := storage.Open(ctx, u.String())
			if err != nil {
				t.Fatalf("open with TimeZone: %v", err)
			}
			t.Cleanup(func() { _ = tzDB.Close() })
			var zone string
			if err := tzDB.QueryRowContext(ctx, `SHOW TimeZone`).Scan(&zone); err != nil {
				t.Fatal(err)
			}
			if zone != "America/New_York" {
				t.Fatalf("session TimeZone = %q, want America/New_York", zone)
			}
			s = New(tzDB, storage.NewBus(tzDB))
		}

		// Tuesday 2026-03-10 03:00Z: Monday 2026-03-09 22:00 in New York.
		at := time.Date(2026, 3, 10, 3, 0, 0, 0, time.UTC)
		flavor := "tz-" + randomUUID(t)[:8]
		agentID := randomUUID(t)
		seedAgent(t, s, agentID, at, at, 1, 100)
		sessionID := randomUUID(t)
		seedSessionRow(t, s, sessionID, agentID, flavor, nil, nil, `{}`, at, 100)
		if _, err := s.db.ExecContext(ctx, `
			INSERT INTO events (id, session_id, flavor, event_type, model, tokens_total, latency_ms, occurred_at, billing_mode)
			VALUES ($1, $2, $3, 'post_call', 'm', 100, 50, $4, 'metered')`,
			randomUUID(t), sessionID, flavor, at); err != nil {
			t.Fatalf("seed event: %v", err)
		}

		for granularity, want := range map[string]string{
			"day":  "2026-03-10",
			"week": "2026-03-09",
			"hour": "2026-03-10T03:00Z",
		} {
			for _, metric := range []string{"tokens", "sessions"} {
				resp, err := s.QueryAnalytics(ctx, AnalyticsParams{
					Metric: metric, GroupBy: "flavor", Range: "custom",
					From: at.Add(-48 * time.Hour), To: at.Add(48 * time.Hour),
					Granularity: granularity, FilterFlavor: flavor,
				})
				if err != nil {
					t.Fatalf("%s/%s: %v", metric, granularity, err)
				}
				if len(resp.Series) != 1 || len(resp.Series[0].Data) != 1 {
					t.Fatalf("%s/%s: series = %+v, want one point", metric, granularity, resp.Series)
				}
				if got := resp.Series[0].Data[0].Date; got != want {
					t.Errorf("%s/%s: bucket %q, want %q", metric, granularity, got, want)
				}
			}
		}
	})
}
