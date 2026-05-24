// Unit tests for GET /v1/search. Covers the validation contract
// (required q, max-200 length), the store-error → 500 branch, and
// the happy-path payload shape. The store layer's SQL is exercised
// separately by search_test.go integration tests.
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

// searchStubQuerier records the most recent Search call so a test
// can assert the handler dispatched (or did not) to the store. The
// embedded Querier panics for any method the handler shouldn't
// touch.
type searchStubQuerier struct {
	store.Querier
	called bool
	resp   *store.SearchResults
	err    error
}

func (s *searchStubQuerier) Search(_ context.Context, _ string) (*store.SearchResults, error) {
	s.called = true
	return s.resp, s.err
}

func TestSearchHandler_MissingQ_Returns400(t *testing.T) {
	stub := &searchStubQuerier{}
	h := SearchHandler(stub)
	req := httptest.NewRequest(http.MethodGet, "/v1/search", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: want 400, got %d", rec.Code)
	}
	if stub.called {
		t.Errorf("store.Search should not be called when q is missing")
	}
}

func TestSearchHandler_EmptyQ_Returns400(t *testing.T) {
	stub := &searchStubQuerier{}
	h := SearchHandler(stub)
	req := httptest.NewRequest(http.MethodGet, "/v1/search?q=", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: want 400, got %d", rec.Code)
	}
	if stub.called {
		t.Errorf("store.Search should not be called when q is empty")
	}
}

func TestSearchHandler_OverlongQ_Returns400(t *testing.T) {
	stub := &searchStubQuerier{}
	h := SearchHandler(stub)
	req := httptest.NewRequest(
		http.MethodGet,
		"/v1/search?q="+strings.Repeat("x", 201),
		nil,
	)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status: want 400, got %d", rec.Code)
	}
	if stub.called {
		t.Errorf("store.Search should not be called when q is too long")
	}
}

func TestSearchHandler_StoreError_Returns500(t *testing.T) {
	stub := &searchStubQuerier{err: errors.New("simulated store failure")}
	h := SearchHandler(stub)
	req := httptest.NewRequest(http.MethodGet, "/v1/search?q=foo", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status: want 500, got %d", rec.Code)
	}
	if !stub.called {
		t.Errorf("store.Search should be called before the error surfaces")
	}
}

func TestSearchHandler_HappyPath_Returns200WithEmptyGroups(t *testing.T) {
	stub := &searchStubQuerier{
		resp: &store.SearchResults{
			Agents:   []store.SearchResultAgent{},
			Sessions: []store.SearchResultSession{},
			Events:   []store.SearchResultEvent{},
		},
	}
	h := SearchHandler(stub)
	req := httptest.NewRequest(http.MethodGet, "/v1/search?q=hello", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d", rec.Code)
	}
	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("content-type: want application/json, got %q", got)
	}
	var body store.SearchResults
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if body.Agents == nil || body.Sessions == nil || body.Events == nil {
		t.Errorf("response groups must be non-nil arrays, got %+v", body)
	}
}

func TestSearchHandler_HappyPath_Returns200WithPopulatedGroups(t *testing.T) {
	stub := &searchStubQuerier{
		resp: &store.SearchResults{
			Agents: []store.SearchResultAgent{{
				AgentID: "00000000-0000-0000-0000-000000000001", AgentName: "a",
				AgentType: "production", LastSeen: "2026-04-17T09:00:00Z",
			}},
			Sessions: []store.SearchResultSession{},
			Events: []store.SearchResultEvent{{
				EventID:   "00000000-0000-0000-0000-000000000002",
				SessionID: "00000000-0000-0000-0000-000000000003",
				EventType: "post_call", OccurredAt: "2026-04-17T09:00:00Z",
			}},
		},
	}
	h := SearchHandler(stub)
	req := httptest.NewRequest(http.MethodGet, "/v1/search?q=a", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: want 200, got %d", rec.Code)
	}
	var body store.SearchResults
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if len(body.Agents) != 1 || body.Agents[0].AgentName != "a" {
		t.Errorf("agents not serialised correctly: %+v", body.Agents)
	}
	if len(body.Events) != 1 || body.Events[0].EventType != "post_call" {
		t.Errorf("events not serialised correctly: %+v", body.Events)
	}
}
