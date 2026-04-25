// Unit tests for the context-filter helper. These exercise the pure
// SQL-generation function without touching Postgres -- the actual
// WHERE execution is covered by the integration suite against a real
// DB. The point here is: for every AllowedContextFilterKeys entry
// (one test each) the generated clause has the right shape, placeholder
// indices advance correctly, and the arg slice extends with the input
// values in order.
package store

import (
	"regexp"
	"testing"
)

// runFilterRoundTripTest exercises BuildContextFilterClause for one
// allowed key: a single value, two values (multi-select), and the
// empty-values no-op path. Every field listed in
// AllowedContextFilterKeys gets its own subtest so the per-field
// coverage count matches the per-facet coverage on the dashboard side.
func runFilterRoundTripTest(t *testing.T, key string) {
	t.Helper()
	t.Run("single value", func(t *testing.T) {
		clause, args, idx, err := BuildContextFilterClause(
			key, []string{"alice"}, []any{"prior-arg"}, 2,
		)
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		wantClause := "s.context->>'" + key + "' IN ($2)"
		if clause != wantClause {
			t.Errorf("clause = %q, want %q", clause, wantClause)
		}
		if len(args) != 2 || args[0] != "prior-arg" || args[1] != "alice" {
			t.Errorf("args = %v, want [prior-arg alice]", args)
		}
		if idx != 3 {
			t.Errorf("nextIdx = %d, want 3", idx)
		}
	})

	t.Run("multi value", func(t *testing.T) {
		clause, args, idx, err := BuildContextFilterClause(
			key, []string{"alice", "bob", "carol"}, []any{}, 1,
		)
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		// Placeholders advance in order; value list preserved order too.
		re := regexp.MustCompile(`^s\.context->>'` + regexp.QuoteMeta(key) + `' IN \(\$1, \$2, \$3\)$`)
		if !re.MatchString(clause) {
			t.Errorf("clause shape wrong: %q", clause)
		}
		if len(args) != 3 || args[0] != "alice" || args[1] != "bob" || args[2] != "carol" {
			t.Errorf("args = %v, want [alice bob carol]", args)
		}
		if idx != 4 {
			t.Errorf("nextIdx = %d, want 4", idx)
		}
	})

	t.Run("empty values is a no-op", func(t *testing.T) {
		clause, args, idx, err := BuildContextFilterClause(
			key, nil, []any{"prior"}, 5,
		)
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
		if clause != "" {
			t.Errorf("clause should be empty on no-op, got %q", clause)
		}
		if len(args) != 1 || args[0] != "prior" {
			t.Errorf("args should be untouched, got %v", args)
		}
		if idx != 5 {
			t.Errorf("nextIdx should be unchanged (5), got %d", idx)
		}
	})
}

// Per-field coverage. Each of the 11 whitelist entries gets its own
// round-trip test (12 total once the per-field subtests are added to
// the test count, counted as 11 here since git_commit is in the
// whitelist alongside the other ten).
func TestBuildContextFilterClause_User(t *testing.T)          { runFilterRoundTripTest(t, "user") }
func TestBuildContextFilterClause_OS(t *testing.T)            { runFilterRoundTripTest(t, "os") }
func TestBuildContextFilterClause_Arch(t *testing.T)          { runFilterRoundTripTest(t, "arch") }
func TestBuildContextFilterClause_Hostname(t *testing.T)      { runFilterRoundTripTest(t, "hostname") }
func TestBuildContextFilterClause_ProcessName(t *testing.T)   { runFilterRoundTripTest(t, "process_name") }
func TestBuildContextFilterClause_NodeVersion(t *testing.T)   { runFilterRoundTripTest(t, "node_version") }
func TestBuildContextFilterClause_PythonVersion(t *testing.T) { runFilterRoundTripTest(t, "python_version") }
func TestBuildContextFilterClause_GitBranch(t *testing.T)     { runFilterRoundTripTest(t, "git_branch") }
func TestBuildContextFilterClause_GitCommit(t *testing.T)     { runFilterRoundTripTest(t, "git_commit") }
func TestBuildContextFilterClause_GitRepo(t *testing.T)       { runFilterRoundTripTest(t, "git_repo") }
func TestBuildContextFilterClause_Orchestration(t *testing.T) { runFilterRoundTripTest(t, "orchestration") }

// TestIsAllowedContextFilterKey_Rejection guards the handler's
// unknown-key drop path. A request with ``?foo=bar`` where foo is
// outside the whitelist must not reach the store helper.
func TestIsAllowedContextFilterKey_Rejection(t *testing.T) {
	for _, key := range AllowedContextFilterKeys {
		if !IsAllowedContextFilterKey(key) {
			t.Errorf("expected %q to be allowed", key)
		}
	}
	for _, key := range []string{"pid", "working_dir", "supports_directives", "frameworks", "flavor", "random"} {
		if IsAllowedContextFilterKey(key) {
			t.Errorf("expected %q to be rejected, is allowed", key)
		}
	}
}

// TestBuildContextFilterClause_ErrorOnUnknownKey documents the
// error-return contract for programming errors (M-11). A direct
// store caller that skipped the handler's whitelist check must
// fail fast with a non-nil error rather than silently inject an
// arbitrary JSONB path. Pre-M-11 the function panicked; the
// callers now surface a 500 instead of crashing the goroutine.
func TestBuildContextFilterClause_ErrorOnUnknownKey(t *testing.T) {
	clause, _, _, err := BuildContextFilterClause(
		"evil_key", []string{"x"}, nil, 1,
	)
	if err == nil {
		t.Fatal("expected error on unknown key, got nil")
	}
	if clause != "" {
		t.Errorf("clause should be empty on error, got %q", clause)
	}
}
