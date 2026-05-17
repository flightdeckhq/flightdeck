// Unit tests for GET /v1/agents/{agent_id}/summary. Covers the
// validation contract (UUID shape, period whitelist, bucket
// whitelist), the 404-when-agent-missing branch, the period →
// bucket defaulting table, and the happy-path payload shape.
//
// The store layer's SQL is exercised separately by the integration
// suite — here we stub Querier so the tests pin the handler's
// boundary behaviour without a live Postgres.

package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

const fakeAgentUUID = "550e8400-e29b-41d4-a716-446655440000"

// agentSummaryStubQuerier captures every store call the handler
// makes so tests can pin the validation contract (e.g. confirm
// the store was NOT called when validation should have rejected
// the request). The embedded Querier panics for any method we
// haven't shadowed.
type agentSummaryStubQuerier struct {
	store.Querier
	// agentByID: when nil and no error, GetAgentByID returns
	// (nil, nil) — the 404 path. When set, the handler proceeds
	// to AgentSummary.
	agentByID    *store.AgentSummary
	agentByIDErr error

	summaryResp   *store.AgentSummaryResponse
	summaryErr    error
	summaryCalled bool
	summaryParams store.AgentSummaryParams
}

func (q *agentSummaryStubQuerier) GetAgentByID(
	_ context.Context, _ string,
) (*store.AgentSummary, error) {
	return q.agentByID, q.agentByIDErr
}

func (q *agentSummaryStubQuerier) AgentSummary(
	_ context.Context, params store.AgentSummaryParams,
) (*store.AgentSummaryResponse, error) {
	q.summaryCalled = true
	q.summaryParams = params
	if q.summaryErr != nil {
		return nil, q.summaryErr
	}
	if q.summaryResp != nil {
		return q.summaryResp, nil
	}
	return &store.AgentSummaryResponse{
		AgentID: params.AgentID,
		Period:  params.Period,
		Bucket:  params.Bucket,
		Series:  []store.AgentSummarySeriesPoint{},
	}, nil
}

func newAgentSummaryRequest(t *testing.T, agentID, query string) *http.Request {
	t.Helper()
	path := "/v1/agents/" + agentID + "/summary"
	if query != "" {
		path += "?" + query
	}
	return httptest.NewRequest(http.MethodGet, path, nil)
}

func TestAgentSummaryHandler_RejectsMalformedUUID(t *testing.T) {
	q := &agentSummaryStubQuerier{}
	rec := httptest.NewRecorder()
	AgentSummaryHandler(q).ServeHTTP(rec,
		newAgentSummaryRequest(t, "not-a-uuid", ""))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "UUID") {
		t.Errorf("body = %q, want to mention UUID", rec.Body.String())
	}
	if q.summaryCalled {
		t.Errorf("AgentSummary called despite 400 validation")
	}
}

func TestAgentSummaryHandler_RejectsExtraPathSegment(t *testing.T) {
	// /v1/agents/<uuid>/extra/summary — the strip logic must not
	// quietly accept a multi-segment id. Confirms that the path
	// parser rejects shapes the route mux might otherwise let
	// through.
	q := &agentSummaryStubQuerier{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet,
		"/v1/agents/"+fakeAgentUUID+"/extra/summary", nil)
	AgentSummaryHandler(q).ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestAgentSummaryHandler_RejectsInvalidPeriod(t *testing.T) {
	q := &agentSummaryStubQuerier{
		agentByID: &store.AgentSummary{AgentID: fakeAgentUUID},
	}
	rec := httptest.NewRecorder()
	AgentSummaryHandler(q).ServeHTTP(rec,
		newAgentSummaryRequest(t, fakeAgentUUID, "period=42d"))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "period") {
		t.Errorf("body = %q, want to mention period", rec.Body.String())
	}
	if q.summaryCalled {
		t.Errorf("AgentSummary called despite invalid period")
	}
}

func TestAgentSummaryHandler_RejectsInvalidBucket(t *testing.T) {
	q := &agentSummaryStubQuerier{
		agentByID: &store.AgentSummary{AgentID: fakeAgentUUID},
	}
	rec := httptest.NewRecorder()
	AgentSummaryHandler(q).ServeHTTP(rec,
		newAgentSummaryRequest(t, fakeAgentUUID, "bucket=month"))

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "bucket") {
		t.Errorf("body = %q, want to mention bucket", rec.Body.String())
	}
	if q.summaryCalled {
		t.Errorf("AgentSummary called despite invalid bucket")
	}
}

func TestAgentSummaryHandler_404OnMissingAgent(t *testing.T) {
	q := &agentSummaryStubQuerier{
		agentByID: nil, // missing — handler should 404
	}
	rec := httptest.NewRecorder()
	AgentSummaryHandler(q).ServeHTTP(rec,
		newAgentSummaryRequest(t, fakeAgentUUID, ""))

	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if q.summaryCalled {
		t.Errorf("AgentSummary called for missing agent — should 404 before query")
	}
}

func TestAgentSummaryHandler_DefaultsPeriodAndBucket(t *testing.T) {
	q := &agentSummaryStubQuerier{
		agentByID: &store.AgentSummary{AgentID: fakeAgentUUID},
	}
	rec := httptest.NewRecorder()
	AgentSummaryHandler(q).ServeHTTP(rec,
		newAgentSummaryRequest(t, fakeAgentUUID, ""))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	if q.summaryParams.Period != "7d" {
		t.Errorf("default period = %q, want 7d", q.summaryParams.Period)
	}
	if q.summaryParams.Bucket != "day" {
		t.Errorf("default bucket = %q, want day", q.summaryParams.Bucket)
	}
}

func TestAgentSummaryHandler_PeriodToBucketDefaulting(t *testing.T) {
	cases := []struct {
		period     string
		wantBucket string
	}{
		{"1h", "hour"},
		{"24h", "hour"},
		{"7d", "day"},
		{"30d", "day"},
	}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.period, func(t *testing.T) {
			q := &agentSummaryStubQuerier{
				agentByID: &store.AgentSummary{AgentID: fakeAgentUUID},
			}
			rec := httptest.NewRecorder()
			AgentSummaryHandler(q).ServeHTTP(rec,
				newAgentSummaryRequest(t, fakeAgentUUID, "period="+tc.period))

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
			}
			if q.summaryParams.Bucket != tc.wantBucket {
				t.Errorf("period=%s derived bucket = %q, want %q",
					tc.period, q.summaryParams.Bucket, tc.wantBucket)
			}
		})
	}
}

func TestAgentSummaryHandler_BucketOverride(t *testing.T) {
	q := &agentSummaryStubQuerier{
		agentByID: &store.AgentSummary{AgentID: fakeAgentUUID},
	}
	rec := httptest.NewRecorder()
	AgentSummaryHandler(q).ServeHTTP(rec,
		newAgentSummaryRequest(t, fakeAgentUUID, "period=7d&bucket=hour"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if q.summaryParams.Bucket != "hour" {
		t.Errorf("explicit bucket override = %q, want hour", q.summaryParams.Bucket)
	}
}

// TestAgentSummaryHandler_BucketOverrideWeek pins the third
// member of the hour/day/week whitelist. Without it, a regression
// that dropped `week` from validAgentSummaryBuckets would not be
// caught by the period-defaulting test (which only exercises
// hour/day derivations) or by the hour-override test.
func TestAgentSummaryHandler_BucketOverrideWeek(t *testing.T) {
	q := &agentSummaryStubQuerier{
		agentByID: &store.AgentSummary{AgentID: fakeAgentUUID},
	}
	rec := httptest.NewRecorder()
	AgentSummaryHandler(q).ServeHTTP(rec,
		newAgentSummaryRequest(t, fakeAgentUUID, "period=30d&bucket=week"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if q.summaryParams.Bucket != "week" {
		t.Errorf("week override = %q, want week", q.summaryParams.Bucket)
	}
}

func TestAgentSummaryHandler_500OnLookupError(t *testing.T) {
	q := &agentSummaryStubQuerier{
		agentByIDErr: errors.New("postgres down"),
	}
	rec := httptest.NewRecorder()
	AgentSummaryHandler(q).ServeHTTP(rec,
		newAgentSummaryRequest(t, fakeAgentUUID, ""))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}

func TestAgentSummaryHandler_500OnQueryError(t *testing.T) {
	q := &agentSummaryStubQuerier{
		agentByID:  &store.AgentSummary{AgentID: fakeAgentUUID},
		summaryErr: errors.New("query timeout"),
	}
	rec := httptest.NewRecorder()
	AgentSummaryHandler(q).ServeHTTP(rec,
		newAgentSummaryRequest(t, fakeAgentUUID, ""))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
}

func TestAgentSummaryHandler_PayloadShape(t *testing.T) {
	// Empty-series happy path: agent exists, no events. The
	// response must carry agent_id + period + bucket + zero totals
	// + a non-nil empty series (the dashboard chart can't tell
	// null from [] otherwise).
	q := &agentSummaryStubQuerier{
		agentByID: &store.AgentSummary{AgentID: fakeAgentUUID},
	}
	rec := httptest.NewRecorder()
	AgentSummaryHandler(q).ServeHTTP(rec,
		newAgentSummaryRequest(t, fakeAgentUUID, "period=7d"))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", rec.Code, rec.Body.String())
	}
	var resp store.AgentSummaryResponse
	if err := json.NewDecoder(rec.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.AgentID != fakeAgentUUID {
		t.Errorf("agent_id = %q, want %q", resp.AgentID, fakeAgentUUID)
	}
	if resp.Period != "7d" || resp.Bucket != "day" {
		t.Errorf("period/bucket = %q/%q, want 7d/day",
			resp.Period, resp.Bucket)
	}
	if resp.Series == nil {
		t.Errorf("series is nil; must be [] (chart code can't tell null from empty array)")
	}
}
