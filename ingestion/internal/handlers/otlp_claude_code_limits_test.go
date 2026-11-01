package handlers

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/identity"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	commonpb "go.opentelemetry.io/proto/slim/otlp/common/v1"
	logspb "go.opentelemetry.io/proto/slim/otlp/logs/v1"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

// manySessions is one log export holding a user_prompt record for each
// of n distinct Claude Code sessions, as a token holder inventing
// session ids would send.
func manySessions(t *testing.T, n int) *collogs.ExportLogsServiceRequest {
	t.Helper()
	reqs := ccLogRequests(t, "bash-json-prompts")
	prompt := recordNamed(t, reqs, "user_prompt")
	var records []*logspb.LogRecord
	for i := range n {
		r := proto.Clone(prompt).(*logspb.LogRecord)
		r.TraceId, r.SpanId = nil, nil // protojson writes them as base64, OTLP JSON as hex
		setAttr(r, "session.id", strVal(fmt.Sprintf("00000000-0000-4000-8000-%012d", i)))
		records = append(records, r)
	}
	return &collogs.ExportLogsServiceRequest{ResourceLogs: []*logspb.ResourceLogs{{
		Resource: reqs[0].ResourceLogs[0].Resource,
		ScopeLogs: []*logspb.ScopeLogs{{
			Scope:      reqs[0].ResourceLogs[0].ScopeLogs[0].Scope,
			LogRecords: records,
		}},
	}}}
}

// A request naming more new sessions than the cap reads only up to the
// cap; the other sessions' records are counted as rejected and nothing
// about them is cached, so a later export reads them.
func TestClaudeCodeSessionReadsAreCapped(t *testing.T) {
	const sessions = maxOTLPSessionReadsPerRequest + 36
	store := newFakeStore()
	d, _ := newTestDialect(store)
	m := d.MapLogs(context.Background(), manySessions(t, sessions))
	if m.Err != nil {
		t.Fatal(m.Err)
	}
	if got := store.lookups(); got != maxOTLPSessionReadsPerRequest {
		t.Errorf("%d reads, want the cap of %d", got, maxOTLPSessionReadsPerRequest)
	}
	// Each read session publishes its start and its pre_call.
	if len(m.Events) != 2*maxOTLPSessionReadsPerRequest {
		t.Errorf("%d events", len(m.Events))
	}
	if m.Rejected != 36 || !strings.Contains(m.Message,
		fmt.Sprintf("past the %d new sessions one request may name (36)", maxOTLPSessionReadsPerRequest)) {
		t.Errorf("rejected %d: %q", m.Rejected, m.Message)
	}
	m.Published()
	if d.cache.len() != maxOTLPSessionReadsPerRequest {
		t.Errorf("cached %d sessions, want only the %d read", d.cache.len(), maxOTLPSessionReadsPerRequest)
	}
	// The next export of the same sessions reads the rest.
	again := d.MapLogs(context.Background(), manySessions(t, sessions))
	if again.Rejected != 0 || store.lookups() != sessions {
		t.Errorf("second export: rejected %d, %d reads in all", again.Rejected, store.lookups())
	}
}

// The reads of one request share a deadline: a store that never answers
// fails the request (503 at the receiver) once it passes.
func TestClaudeCodeSessionReadsHaveADeadline(t *testing.T) {
	store := newFakeStore()
	store.block = true
	d, _ := newTestDialect(store)
	start := time.Now()
	m := d.MapLogs(context.Background(), manySessions(t, 3))
	elapsed := time.Since(start)
	if !errors.Is(m.Err, context.DeadlineExceeded) {
		t.Fatalf("Err = %v, want the deadline", m.Err)
	}
	if elapsed < otlpSessionLookupTimeout || elapsed > 3*otlpSessionLookupTimeout {
		t.Errorf("returned after %v, deadline %v", elapsed, otlpSessionLookupTimeout)
	}
	if store.lookups() != 1 || len(m.Events) != 0 {
		t.Errorf("%d reads, %d events", store.lookups(), len(m.Events))
	}
}

// A request whose records cannot fit the token's budget is refused
// before any session is read: 413 past the whole budget, 429 past what
// is left of it, neither charged.
func TestOTLPHandlerRefusesOverBudgetBeforeReading(t *testing.T) {
	body, err := protojson.Marshal(manySessions(t, 40))
	if err != nil {
		t.Fatal(err)
	}

	store := newFakeStore()
	d, _ := newTestDialect(store)
	h := OTLPLogsHandler(tokenValidator{}, &recordingPublisher{}, &fakeAttacher{}, d, NewRateLimiter(30))
	w := postOTLP(h, otlpMediaJSON, false, body)
	if w.Code != http.StatusRequestEntityTooLarge || !strings.Contains(w.Body.String(), "up to 40 events") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if store.lookups() != 0 {
		t.Errorf("%d reads before the 413", store.lookups())
	}

	limiter := NewRateLimiter(100)
	if ok, _ := limiter.AllowN("tok", 70); !ok {
		t.Fatal("setup charge refused")
	}
	h = OTLPLogsHandler(tokenValidator{}, &recordingPublisher{}, &fakeAttacher{}, d, limiter)
	w = postOTLP(h, otlpMediaJSON, false, body)
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") == "" {
		t.Fatalf("%d %s (Retry-After %q)", w.Code, w.Body, w.Header().Get("Retry-After"))
	}
	if store.lookups() != 0 {
		t.Errorf("%d reads before the 429", store.lookups())
	}
	if ok, _ := limiter.Fits("tok", 30); !ok {
		t.Error("a refused request was charged")
	}
}

func TestRateLimiterFitsChargesNothing(t *testing.T) {
	l := NewRateLimiter(10)
	for range 3 {
		if ok, _ := l.Fits("tok", 10); !ok {
			t.Fatal("ten units do not fit an empty window of ten")
		}
	}
	if ok, retry := l.Fits("tok", 11); ok || retry <= 0 {
		t.Errorf("eleven units fit (%v, retry %d)", ok, retry)
	}
	if ok, _ := l.AllowN("tok", 10); !ok {
		t.Error("Fits charged the window")
	}
}

// childToolResult is an export holding only the sub-agent's tool result
// of the recorded sub-agent run (a record that names no role).
func childToolResult(t *testing.T) *collogs.ExportLogsServiceRequest {
	t.Helper()
	reqs := ccLogRequests(t, "subagent-json")
	var tool *logspb.LogRecord
	for _, r := range recordsOf(reqs) {
		a := newOTLPAttrs(r.GetAttributes())
		if a.text("event.name") == "tool_result" && a.text("agent_id") != "" {
			tool = r
		}
	}
	if tool == nil {
		t.Fatal("no sub-agent tool_result in the fixture")
	}
	return &collogs.ExportLogsServiceRequest{ResourceLogs: []*logspb.ResourceLogs{{
		Resource: reqs[0].ResourceLogs[0].Resource,
		ScopeLogs: []*logspb.ScopeLogs{{
			Scope:      reqs[0].ResourceLogs[0].ScopeLogs[0].Scope,
			LogRecords: []*logspb.LogRecord{tool},
		}},
	}}}
}

// A sub-agent's record that names no role takes it from the child's row
// when the replica has nothing cached (its entry expired, or another
// replica saw the earlier records).
func TestClaudeCodeSubagentRoleFromStoredRow(t *testing.T) {
	root := identity.UUID5(identity.NamespaceFlightdeck, "flightdeck://otlp/claude-code/session/"+ccSubagentSession)
	child := identity.UUID5(identity.NamespaceFlightdeck,
		"flightdeck://otlp/claude-code/session/"+ccSubagentSession+"/"+ccSubagentAgentID)
	store := newFakeStore()
	store.rows[root], store.rows[child] = "active", "active"
	store.roles[child] = "general-purpose"
	d, _ := newTestDialect(store) // nothing cached: as after expiry, or on another replica

	events, _, _ := mapAll(t, d, []*collogs.ExportLogsServiceRequest{childToolResult(t)})
	if len(events) != 1 || events[0].Type != "tool_call" {
		t.Fatalf("mapped %v", eventTypes(events))
	}
	p := events[0].P
	wantAgent := identity.AgentID("coding", ccFixtureUser, "unknown", "claude_code", ccFixtureUser+"@unknown", "general-purpose")
	if p["agent_role"] != "general-purpose" || p["agent_id"] != wantAgent {
		t.Errorf("role %v, agent_id %v (want %s)", p["agent_role"], p["agent_id"], wantAgent)
	}
	if e, ok := d.cache.get(child); !ok || e.role != "general-purpose" {
		t.Errorf("the stored role was not cached: %+v %v", e, ok)
	}
}

// A late record of a finished sub-agent does not reopen it: a closed
// child row gets no synthetic session_start (a closed root does, since
// a resumed Claude Code session reports under the same id).
func TestClaudeCodeClosedChildIsNotRestarted(t *testing.T) {
	root := identity.UUID5(identity.NamespaceFlightdeck, "flightdeck://otlp/claude-code/session/"+ccSubagentSession)
	child := identity.UUID5(identity.NamespaceFlightdeck,
		"flightdeck://otlp/claude-code/session/"+ccSubagentSession+"/"+ccSubagentAgentID)
	store := newFakeStore()
	store.rows[root], store.rows[child] = "active", "closed"
	d, _ := newTestDialect(store)
	events, _, _ := mapAll(t, d, []*collogs.ExportLogsServiceRequest{childToolResult(t)})
	if len(ofType(events, "session_start")) != 0 {
		t.Errorf("a closed child was started again: %v", eventTypes(events))
	}

	missing := newFakeStore()
	missing.rows[root] = "active"
	d2, _ := newTestDialect(missing)
	events2, _, _ := mapAll(t, d2, []*collogs.ExportLogsServiceRequest{childToolResult(t)})
	if got := eventTypes(events2); len(got) != 2 || got[0] != "session_start" {
		t.Errorf("a missing child was not started: %v", got)
	}
}

// A tool input that decodes to JSON null is no content.
func TestClaudeCodeNullToolInputIsNoContent(t *testing.T) {
	reqs := ccLogRequests(t, "bash-json-prompts")
	setResourceAttr(reqs, otlpAttrCapturePrompts, "true")
	setAttr(recordNamed(t, reqs, "tool_result"), "tool_input",
		&commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: "null"}})
	d, _ := newTestDialect(newFakeStore())
	events, _, _ := mapAll(t, d, reqs)
	tool := ofType(events, "tool_call")[0].P
	if tool["has_content"] != false || tool["content"] != nil {
		t.Errorf("null tool_input: has_content %v, content %v", tool["has_content"], tool["content"])
	}
}

// A full cache of live entries is swept at most once per interval, not
// on every new session.
func TestOTLPSessionCacheSweepIsRateLimited(t *testing.T) {
	c := &clock{t: ccFixtureNow}
	cache := newOTLPSessionCache(c.now)
	for i := range otlpSessionCacheMaxEntries {
		cache.put(fmt.Sprintf("s-%d", i), false, "")
	}
	cache.put("first", false, "") // sweeps, finds nothing expired
	if _, ok := cache.get("first"); ok {
		t.Fatal("a full cache of live entries took a new one")
	}
	// Expire everything without moving the clock: the next put inside
	// the interval must not sweep, so it still finds the cache full.
	cache.mu.Lock()
	for id, e := range cache.entries {
		e.expires = c.now()
		cache.entries[id] = e
	}
	cache.mu.Unlock()
	cache.put("second", false, "")
	if cache.len() != otlpSessionCacheMaxEntries {
		t.Errorf("swept inside the interval: %d entries", cache.len())
	}
	c.advance(otlpSessionCacheSweepInterval)
	cache.put("third", false, "")
	if cache.len() != 1 {
		t.Errorf("after the interval the sweep left %d entries", cache.len())
	}
}
