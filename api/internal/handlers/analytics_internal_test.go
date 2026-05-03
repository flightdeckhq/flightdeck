package handlers

import (
	"reflect"
	"testing"
)

// TestSplitGroupBy_SinglePassThrough is the regression guard for
// the single-dim wire-shape promise: any group_by value with no
// comma must return a single-element slice byte-identical to the
// input. If this drifts, every pre-D126 client breaks at once
// because the handler's primary-axis lookup walks parts[0].
func TestSplitGroupBy_SinglePassThrough(t *testing.T) {
	for _, in := range []string{"flavor", "model", "agent_role", "parent_session_id"} {
		got := splitGroupBy(in)
		if !reflect.DeepEqual(got, []string{in}) {
			t.Errorf("splitGroupBy(%q) = %v; want %v", in, got, []string{in})
		}
	}
}

// TestSplitGroupBy_TwoDim covers the canonical pair driving the
// dashboard's per-parent stacked chart.
func TestSplitGroupBy_TwoDim(t *testing.T) {
	got := splitGroupBy("parent_session_id,agent_role")
	want := []string{"parent_session_id", "agent_role"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("splitGroupBy 2-dim = %v; want %v", got, want)
	}
}

// TestSplitGroupBy_StripsEmptyAndWhitespace ensures URLs hand-
// crafted with stray whitespace or doubled commas (from
// copy-paste errors) parse to the same canonical shape rather
// than leaking a phantom third axis past the validator.
func TestSplitGroupBy_StripsEmptyAndWhitespace(t *testing.T) {
	cases := map[string][]string{
		"flavor, model":           {"flavor", "model"},
		"flavor,,model":           {"flavor", "model"},
		" flavor , model ":        {"flavor", "model"},
		"flavor,":                 {"flavor"},
		",flavor":                 {"flavor"},
		"":                        {},
		",,":                      {},
		"parent_session_id ,role": {"parent_session_id", "role"},
	}
	for in, want := range cases {
		got := splitGroupBy(in)
		if !reflect.DeepEqual(got, want) {
			t.Errorf("splitGroupBy(%q) = %v; want %v", in, got, want)
		}
	}
}

// TestSplitGroupBy_RejectsThreeDim doesn't actually hit the
// 3-dim rejection path (splitGroupBy itself returns the parsed
// slice — the handler turns >2 into a 400). The test pins the
// intermediate behavior so the handler-level guard has something
// to assert against.
func TestSplitGroupBy_RejectsThreeDim(t *testing.T) {
	got := splitGroupBy("a,b,c")
	if len(got) != 3 {
		t.Fatalf("splitGroupBy 3-dim should return 3 parts; got %d (%v)", len(got), got)
	}
}
