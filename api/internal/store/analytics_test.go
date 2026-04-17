package store

import (
	"strings"
	"testing"
)

// TestFrameworkDimensionUsesLateralUnnest guards the fix that made
// group_by=framework report real framework names instead of collapsing
// every row to 'unknown'. The sensor writes framework versions to
// sessions.context->'frameworks' (a JSONB array), so the dimension
// expression must reference the unnested alias ``fw`` and the
// dimensionSource must contribute a LATERAL join fragment that the
// FROM clause builder appends to the query.
func TestFrameworkDimensionUsesLateralUnnest(t *testing.T) {
	dim, ok := dimensions["framework"]
	if !ok {
		t.Fatalf("dimensions[\"framework\"] is missing")
	}
	if dim.exprEvents != "fw" || dim.exprSessions != "fw" {
		t.Errorf(
			"framework dimension must project the unnested alias ``fw``; got exprEvents=%q exprSessions=%q",
			dim.exprEvents, dim.exprSessions,
		)
	}
	if !dim.needsSessionJoin {
		t.Error("framework dimension must set needsSessionJoin=true for event-based metrics")
	}
	if dim.fromExtras == "" {
		t.Fatal("framework dimension must carry a LATERAL join in fromExtras")
	}
	if !strings.Contains(dim.fromExtras, "jsonb_array_elements_text") {
		t.Errorf(
			"framework fromExtras must unnest via jsonb_array_elements_text; got %q",
			dim.fromExtras,
		)
	}
	if !strings.Contains(dim.fromExtras, "s.context->'frameworks'") {
		t.Errorf(
			"framework fromExtras must read s.context->'frameworks'; got %q",
			dim.fromExtras,
		)
	}
	if !strings.Contains(dim.fromExtras, "LEFT JOIN LATERAL") {
		t.Errorf(
			"framework fromExtras must be LEFT JOIN LATERAL so sessions with no frameworks still produce an 'unknown' row; got %q",
			dim.fromExtras,
		)
	}
}

// TestNonFrameworkDimensionsHaveNoFromExtras ensures the fromExtras
// escape hatch is only used by the framework dimension. If a future
// dimension needs it, the dimensions map entry and this assertion
// should be updated together.
func TestNonFrameworkDimensionsHaveNoFromExtras(t *testing.T) {
	for name, dim := range dimensions {
		if name == "framework" {
			continue
		}
		if dim.fromExtras != "" {
			t.Errorf("dimensions[%q].fromExtras should be empty, got %q", name, dim.fromExtras)
		}
	}
}
