package store

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// The queries the scale check rewrote, in the shape they had before,
// run beside the current ones on a seeded history: the rewrite must
// return the same rows, in the same order, on both backends.

// seededStore is a store on a history of a few thousand events written
// by storagetest.SeedScale, in a database of its own.
func seededStore(t *testing.T, b storage.Backend) (*Store, *storagetest.ScaleStats) {
	t.Helper()
	db := storagetest.OpenIsolated(t, b)
	stats, err := storagetest.SeedScale(context.Background(), db, storagetest.ScaleSpec{
		Events: 800, Seed: 11, End: time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	return New(db, storage.NewBus(db)), stats
}

// recentSessionsBeforeRewrite is GetRecentSessionsByAgentIDs' query as
// it was: every per-run column computed for every run of the agents,
// before the rank filter.
func (s *Store) recentSessionsBeforeRewrite() string {
	return `
		SELECT
			t.session_id, t.flavor, t.agent_type, t.agent_id,
			t.agent_name, t.client_type, t.host, t.model, t.framework,
			t.state,
			t.started_at, t.ended_at, t.last_seen_at, t.tokens_used,
			t.token_limit, t.capture_enabled,
			t.parent_session_id, t.parent_agent_id, t.agent_role,
			` + s.closeReasonsSQL("t.session_key") + ` AS close_reasons
		FROM (
			SELECT
				s.session_id AS session_key,
				CAST(s.session_id AS TEXT) AS session_id,
				s.flavor, s.agent_type,
				CAST(s.agent_id AS TEXT) AS agent_id,
				s.agent_name, s.client_type, s.host, s.model, s.framework,
				s.state, s.started_at, s.ended_at, s.last_seen_at, s.tokens_used,
				s.token_limit,
				` + captureEnabledSQL("s.session_id") + ` AS capture_enabled,
				CAST(s.parent_session_id AS TEXT) AS parent_session_id,
				CAST(parent_s.agent_id AS TEXT) AS parent_agent_id,
				s.agent_role,
				ROW_NUMBER() OVER (
					PARTITION BY s.agent_id
					ORDER BY s.started_at DESC, s.session_id ASC
				) AS rn
			FROM sessions s
			LEFT JOIN sessions parent_s
				ON parent_s.session_id = s.parent_session_id
			WHERE ` + s.d.InUUIDArray("s.agent_id", "$1") + `
		) t
		WHERE t.rn <= $2
		ORDER BY t.agent_id, t.started_at DESC, t.session_id ASC
	`
}

func TestRecentSessionsRewrite_ReturnsTheSameRows(t *testing.T) {
	for _, b := range storagetest.Backends(t) {
		t.Run(string(b), func(t *testing.T) {
			s, stats := seededStore(t, b)
			ctx := context.Background()
			var ids []string
			rows, err := s.reader().QueryContext(ctx, `SELECT CAST(agent_id AS TEXT) FROM agents ORDER BY agent_id`)
			if err != nil {
				t.Fatal(err)
			}
			for rows.Next() {
				var id string
				if err := rows.Scan(&id); err != nil {
					t.Fatal(err)
				}
				ids = append(ids, id)
			}
			_ = rows.Close()
			if len(ids) != stats.Agents || len(ids) < 10 {
				t.Fatalf("%d agents, want the seeded %d", len(ids), stats.Agents)
			}

			for _, perAgent := range []int{1, RecentSessionsPerAgent, 50} {
				got, err := s.GetRecentSessionsByAgentIDs(ctx, ids, perAgent)
				if err != nil {
					t.Fatal(err)
				}
				want := map[string][]RecentSession{}
				old, err := s.reader().QueryContext(ctx, s.recentSessionsBeforeRewrite(), s.d.ArrayArg(ids), perAgent)
				if err != nil {
					t.Fatal(err)
				}
				n := 0
				for old.Next() {
					var r RecentSession
					var closeReasons jsonStrings
					if err := old.Scan(
						&r.SessionID, &r.Flavor, &r.AgentType, &r.AgentID,
						&r.AgentName, &r.ClientType, &r.Host, &r.Model,
						&r.Framework, &r.State,
						&r.StartedAt, &r.EndedAt, &r.LastSeenAt, &r.TokensUsed,
						&r.TokenLimit, &r.CaptureEnabled,
						&r.ParentSessionID, &r.ParentAgentID, &r.AgentRole,
						&closeReasons,
					); err != nil {
						t.Fatal(err)
					}
					r.CloseReasons = closeReasons.strings()
					want[*r.AgentID] = append(want[*r.AgentID], r)
					n++
				}
				_ = old.Close()
				if n == 0 {
					t.Fatal("the old query returned no rows")
				}
				if !reflect.DeepEqual(got, want) {
					t.Errorf("perAgent=%d: the rewritten query returns other rows than the old one", perAgent)
				}
			}
		})
	}
}

// sessionFacetBeforeRewrite is a session-level facet as it was: every
// event of the window joined to its run.
func sessionFacetBeforeRewrite(col, filtered string) string {
	return fmt.Sprintf(`
		SELECT v, COUNT(*) AS c FROM (
			SELECT %s AS v
			FROM %s f
			JOIN sessions s ON s.session_id = f.session_id
		) d
		WHERE v IS NOT NULL AND v <> ''
		GROUP BY v
		ORDER BY c DESC, v ASC
		LIMIT %d
	`, col, filtered, facetTopN)
}

func TestSessionFacetsRewrite_ReturnsTheSameCounts(t *testing.T) {
	end := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	for _, b := range storagetest.Backends(t) {
		t.Run(string(b), func(t *testing.T) {
			s, _ := seededStore(t, b)
			ctx := context.Background()
			for _, params := range []EventsParams{
				{From: end.Add(-365 * 24 * time.Hour), To: end},
				{From: end.Add(-30 * 24 * time.Hour), To: end},
				{From: end.Add(-365 * 24 * time.Hour), To: end, Flavor: "claude-code"},
				{From: end.Add(-365 * 24 * time.Hour), To: end, EventTypes: []string{"post_call", "tool_call"}},
			} {
				got, err := s.GetEventFacets(ctx, params)
				if err != nil {
					t.Fatal(err)
				}
				conditions, args := s.buildEventsWhere(params)
				filtered := fmt.Sprintf("(SELECT * FROM events WHERE %s)", strings.Join(conditions, " AND "))
				exprs := s.eventFacetExprs()
				tx, err := s.readTx(ctx)
				if err != nil {
					t.Fatal(err)
				}
				nonEmpty := 0
				for name, gotValues := range map[string][]EventFacetValue{
					"agent_id": got.AgentID, "framework": got.Framework, "os": got.OS, "arch": got.Arch,
					"hostname": got.Hostname, "user": got.User, "git_branch": got.GitBranch, "git_repo": got.GitRepo,
					"orchestration": got.Orchestration, "python_version": got.PythonVersion, "process_name": got.ProcessName,
				} {
					want, err := scanFacet(ctx, tx, sessionFacetBeforeRewrite(exprs[name], filtered), args)
					if err != nil {
						t.Fatal(err)
					}
					if len(want) > 0 {
						nonEmpty++
					}
					if !reflect.DeepEqual(gotValues, want) {
						t.Errorf("%+v: facet %s = %v, the old query gives %v", params, name, gotValues, want)
					}
				}
				_ = tx.Rollback()
				if nonEmpty < 6 {
					t.Errorf("%+v: only %d session facets have values; the comparison proves little", params, nonEmpty)
				}
			}
		})
	}
}
