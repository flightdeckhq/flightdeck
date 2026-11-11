package store

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// The newest-first lists order by a timestamp the server stamps. On
// SQLite that timestamp resolves one millisecond, so rows written in a
// burst share it; these tests force the tie (every row carries one
// explicit timestamp) and pin the order among the tied rows: on SQLite
// the last inserted first, the order a finer clock would have given;
// on Postgres, which keeps no insertion order, by id, descending.

// tieStamp is the timestamp every tied row carries.
var tieStamp = time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)

// tiedRows is how many rows share the timestamp. Enough that an order
// left to the scan, or to a sort on random ids, cannot match by chance.
const tiedRows = 12

// wantTieOrder is the order a newest-first list returns the tied rows
// in, given their ids in insertion order.
func wantTieOrder(backend storage.Backend, inserted []string) []string {
	want := slices.Clone(inserted)
	if backend == storage.Postgres {
		slices.Sort(want)
	}
	slices.Reverse(want)
	return want
}

func requireTieOrder(t *testing.T, what string, got, want []string) {
	t.Helper()
	if !slices.Equal(got, want) {
		t.Fatalf("%s came back as\n%v\nwant\n%v", what, got, want)
	}
}

func TestListAccessTokens_BreaksACreatedAtTie(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		marker := "tie-token-" + strings.ReplaceAll(randomUUID(t), "-", "")[:12]
		t.Cleanup(func() {
			_, _ = s.db.ExecContext(context.Background(), `DELETE FROM access_tokens WHERE name LIKE $1`, marker+"%")
		})
		var inserted []string
		for i := range tiedRows {
			var id string
			if err := s.db.QueryRowContext(ctx, `
				INSERT INTO access_tokens (name, token_hash, salt, prefix, created_at)
				VALUES ($1, $2, 's', 'ftd_tie0', $3) RETURNING CAST(id AS TEXT)`,
				fmt.Sprintf("%s-%02d", marker, i), fmt.Sprintf("%s-hash-%02d", marker, i), tieStamp).Scan(&id); err != nil {
				t.Fatal(err)
			}
			inserted = append(inserted, id)
		}
		list := func() []string {
			t.Helper()
			rows, err := s.ListAccessTokens(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, r := range rows {
				if strings.HasPrefix(r.Name, marker) {
					got = append(got, r.ID)
				}
			}
			return got
		}
		want := wantTieOrder(s.db.Backend, inserted)
		requireTieOrder(t, "the tokens", list(), want)
		requireTieOrder(t, "the tokens, read again,", list(), want)
	})
}

func TestGetPolicies_BreaksACreatedAtTie(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		marker := "tie-policy-" + strings.ReplaceAll(randomUUID(t), "-", "")[:12]
		t.Cleanup(func() {
			_, _ = s.db.ExecContext(context.Background(), `DELETE FROM token_policies WHERE scope_value LIKE $1`, marker+"%")
		})
		var inserted []string
		for i := range tiedRows {
			var id string
			if err := s.db.QueryRowContext(ctx, `
				INSERT INTO token_policies (scope, scope_value, token_limit, created_at, updated_at)
				VALUES ('flavor', $1, 1000, $2, $2) RETURNING CAST(id AS TEXT)`,
				fmt.Sprintf("%s-%02d", marker, i), tieStamp).Scan(&id); err != nil {
				t.Fatal(err)
			}
			inserted = append(inserted, id)
		}
		policies, err := s.GetPolicies(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, p := range policies {
			if strings.HasPrefix(p.ScopeValue, marker) {
				got = append(got, p.ID)
			}
		}
		requireTieOrder(t, "the policies", got, wantTieOrder(s.db.Backend, inserted))
	})
}

// A sensor registers its custom directives in one burst; the list
// shows the last registered first, with and without the flavor filter.
func TestGetCustomDirectives_BreaksARegisteredAtTie(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		flavor := "tie-directive-" + strings.ReplaceAll(randomUUID(t), "-", "")[:12]
		t.Cleanup(func() {
			_, _ = s.db.ExecContext(context.Background(), `DELETE FROM custom_directives WHERE flavor = $1`, flavor)
		})
		var inserted []string
		for i := range tiedRows {
			var id string
			if err := s.db.QueryRowContext(ctx, `
				INSERT INTO custom_directives (fingerprint, name, flavor, registered_at, last_seen_at)
				VALUES ($1, $2, $3, $4, $4) RETURNING CAST(id AS TEXT)`,
				fmt.Sprintf("fp-%02d", i), fmt.Sprintf("directive-%02d", i), flavor, tieStamp).Scan(&id); err != nil {
				t.Fatal(err)
			}
			inserted = append(inserted, id)
		}
		want := wantTieOrder(s.db.Backend, inserted)
		for _, filter := range []string{flavor, ""} {
			directives, err := s.GetCustomDirectives(ctx, filter)
			if err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, d := range directives {
				if d.Flavor == flavor {
					got = append(got, d.ID)
				}
			}
			requireTieOrder(t, fmt.Sprintf("the custom directives (flavor filter %q)", filter), got, want)
		}
	})
}
