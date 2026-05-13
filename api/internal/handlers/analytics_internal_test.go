package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
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

// analyticsStubQuerier captures the AnalyticsParams the handler
// passes to QueryAnalytics so tests can assert which filters made
// it through validation. Every other Querier method panics — the
// handler under test must not call them.
type analyticsStubQuerier struct {
	store.Querier
	captured store.AnalyticsParams
}

func (q *analyticsStubQuerier) QueryAnalytics(
	_ context.Context, params store.AnalyticsParams,
) (*store.AnalyticsResponse, error) {
	q.captured = params
	return &store.AnalyticsResponse{
		Metric:      params.Metric,
		GroupBy:     params.GroupBy,
		Range:       params.Range,
		Granularity: params.Granularity,
		Series:      []store.AnalyticsSeries{},
	}, nil
}

func TestAnalyticsHandler_FilterAgentID_RejectsMalformedUUID(t *testing.T) {
	q := &analyticsStubQuerier{}
	req := httptest.NewRequest(http.MethodGet,
		"/v1/analytics?metric=tokens&filter_agent_id=not-a-uuid", nil)
	rec := httptest.NewRecorder()

	AnalyticsHandler(q).ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "filter_agent_id") {
		t.Errorf("body = %q, want to mention filter_agent_id", rec.Body.String())
	}
	// QueryAnalytics must NOT have been called — validation rejects
	// before reaching the store.
	if q.captured.Metric != "" {
		t.Errorf("QueryAnalytics called despite 400; captured = %+v", q.captured)
	}
}

func TestAnalyticsHandler_FilterAgentID_PassesThroughValidUUID(t *testing.T) {
	q := &analyticsStubQuerier{}
	uuid := "550e8400-e29b-41d4-a716-446655440000"
	req := httptest.NewRequest(http.MethodGet,
		"/v1/analytics?metric=tokens&filter_agent_id="+uuid, nil)
	rec := httptest.NewRecorder()

	AnalyticsHandler(q).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if q.captured.FilterAgentID != uuid {
		t.Errorf("captured FilterAgentID = %q, want %q",
			q.captured.FilterAgentID, uuid)
	}
}

func TestAnalyticsHandler_FilterAgentID_EmptyIsNoOp(t *testing.T) {
	q := &analyticsStubQuerier{}
	req := httptest.NewRequest(http.MethodGet,
		"/v1/analytics?metric=tokens", nil)
	rec := httptest.NewRecorder()

	AnalyticsHandler(q).ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if q.captured.FilterAgentID != "" {
		t.Errorf("captured FilterAgentID = %q, want empty",
			q.captured.FilterAgentID)
	}
	// And the response shape still decodes cleanly — guards against
	// a swaggo annotation drift breaking the JSON encoder path.
	var resp store.AnalyticsResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Errorf("response decode: %v", err)
	}
}
