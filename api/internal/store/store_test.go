package store

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// eachStore runs fn once per covered backend (storagetest.Each), with a
// Store on a migrated database: SQLite always, in a file of the test's
// own; Postgres when TEST_POSTGRES_URL names a database. The Postgres
// database is shared by the package's tests, so every test keeps to
// rows it created (random ids, unique flavors) and removes them in
// t.Cleanup.
func eachStore(t *testing.T, fn func(t *testing.T, s *Store)) {
	t.Helper()
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		fn(t, New(db, storage.NewBus(db)))
	})
}

// testNow is the current time at the millisecond, the precision both
// backends keep, so a timestamp written and read back compares equal.
func testNow() time.Time {
	return time.Now().UTC().Truncate(time.Millisecond)
}

// jsonObject renders v as JSON text for a JSON column argument.
func jsonObject(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("marshal %v: %v", v, err)
	}
	return string(b)
}

// A context key whose value is JSON null, and a null inside an array,
// are not facet values: they are skipped on both engines instead of
// failing the whole facets read.
func TestGetContextFacetsSkipJSONNull(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		tag := randomUUID(t)[:8]
		agentID := randomUUID(t)
		seedAgent(t, s, agentID, testNow(), testNow(), 1, 0)
		seedSessionRow(t, s, randomUUID(t), agentID, "facets-null-"+tag, nil, nil,
			`{"nullkey_`+tag+`": null, "arr_`+tag+`": [null, "x-`+tag+`"]}`, testNow(), 0)

		facets, err := s.GetContextFacets(ctx)
		if err != nil {
			t.Fatalf("GetContextFacets: %v", err)
		}
		if got, ok := facets["nullkey_"+tag]; ok {
			t.Errorf("a null-valued key is listed as a facet: %+v", got)
		}
		arr := facets["arr_"+tag]
		if len(arr) != 1 || arr[0].Value != "x-"+tag || arr[0].Count != 1 {
			t.Errorf("array with a null element: got %+v, want the one value x-%s counted once", arr, tag)
		}
	})
}

// GetContextFacets unnests array-typed context values element by
// element: frameworks=["langchain/0.1.12","crewai/0.42.0"] shows as two
// distinct facet values, each counted independently, never as the one
// stringified value "[...]". Booleans render as true / false text and
// scalars as their text on both engines.
func TestGetContextFacetsUnnestArrayValues(t *testing.T) {
	eachStore(t, func(t *testing.T, s *Store) {
		ctx := context.Background()
		tag := randomUUID(t)[:8]
		agentID := randomUUID(t)
		seedAgent(t, s, agentID, testNow(), testNow(), 3, 0)
		// Three sessions:
		//   s1: frameworks = ["langchain/0.1.12-<tag>"]
		//   s2: frameworks = ["langchain/0.1.12-<tag>", "crewai/0.42.0-<tag>"]
		//   s3: frameworks = ["autogen/0.2.34-<tag>"], os = "Linux-<tag>",
		//       supports_directives = true, python_version = 3.12
		// Expected unnested counts:
		//   frameworks/langchain/0.1.12-<tag> = 2
		//   frameworks/crewai/0.42.0-<tag>    = 1
		//   frameworks/autogen/0.2.34-<tag>   = 1
		//   os/Linux-<tag>                    = 1
		//   supports_directives/true          >= 1
		for i, contextJSON := range []string{
			`{"frameworks": ["langchain/0.1.12-` + tag + `"]}`,
			`{"frameworks": ["langchain/0.1.12-` + tag + `","crewai/0.42.0-` + tag + `"]}`,
			`{"frameworks": ["autogen/0.2.34-` + tag + `"], "os": "Linux-` + tag + `", "supports_directives": true, "python_version": "3.12-` + tag + `"}`,
		} {
			seedSessionRow(t, s, randomUUID(t), agentID, "facets-"+tag, nil, nil,
				contextJSON, testNow().Add(-time.Duration(i)*time.Minute), 0)
		}

		facets, err := s.GetContextFacets(ctx)
		if err != nil {
			t.Fatalf("GetContextFacets: %v", err)
		}
		counts := func(key string) map[string]int {
			out := map[string]int{}
			for _, v := range facets[key] {
				out[v.Value] = v.Count
			}
			return out
		}
		fw := counts("frameworks")
		for value, want := range map[string]int{
			"langchain/0.1.12-" + tag: 2,
			"crewai/0.42.0-" + tag:    1,
			"autogen/0.2.34-" + tag:   1,
		} {
			if fw[value] != want {
				t.Errorf("frameworks facet %q: count=%d, want %d", value, fw[value], want)
			}
		}
		for value := range fw {
			if len(value) > 0 && value[0] == '[' {
				t.Errorf("frameworks facet contains stringified array %q", value)
			}
		}
		if got := counts("os")["Linux-"+tag]; got != 1 {
			t.Errorf("os facet Linux-%s: count=%d, want 1", tag, got)
		}
		if got := counts("python_version")["3.12-"+tag]; got != 1 {
			t.Errorf("python_version facet: count=%d, want 1", got)
		}
		if got := counts("supports_directives")["true"]; got < 1 {
			t.Errorf("supports_directives facet: true counted %d times, want at least 1 (values: %v)",
				got, facets["supports_directives"])
		}
		// Within a key, values come most-common first.
		if vals := facets["frameworks"]; len(vals) > 1 {
			for i := 1; i < len(vals); i++ {
				if vals[i].Count > vals[i-1].Count {
					t.Errorf("frameworks facet not ordered by count: %v", vals)
					break
				}
			}
		}
	})
}
