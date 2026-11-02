package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/identity"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	logspb "go.opentelemetry.io/proto/slim/otlp/logs/v1"
	"google.golang.org/protobuf/proto"
)

// The Claude Code sessions of the recorded resumed and woken sub-agents.
const (
	ccResumeSession = "805bb271-f5d5-47a7-b0c6-1b187b8cdc08"
	ccResumeAgentID = "a2b4b053fbdbd8324"
	ccWakeSession   = "2f93a086-ec21-4dbe-b63b-a627b3855e2c"
	ccWakeAgentID   = "ac2db042948fd3e03"
)

// ccResumeFixtureNow is a few minutes after the resumed and woken
// sub-agents were recorded (2026-11-02 09:20-09:21 UTC), so their
// timestamps sit inside the validation window.
var ccResumeFixtureNow = time.Date(2026, 11, 2, 9, 25, 0, 0, time.UTC)

func newResumeTestDialect(store ClaudeCodeSessionStore) *ClaudeCodeDialect {
	c := &clock{t: ccResumeFixtureNow}
	return newClaudeCodeDialect(store, c.now)
}

// ccSessionUUID is the Flightdeck id of a Claude Code session, or of
// one of its sub-agents, derived here independently of the dialect.
func ccSessionUUID(claudeCodeSession, agentID string) string {
	name := "flightdeck://otlp/claude-code/session/" + claudeCodeSession
	if agentID != "" {
		name += "/" + agentID
	}
	return identity.UUID5(identity.NamespaceFlightdeck, name)
}

// mapAsWorker maps requests in order as mapAll does and, after each,
// applies its events to the store as the worker would before Claude
// Code's next export arrives.
func mapAsWorker(t *testing.T, d *ClaudeCodeDialect, store *fakeSessionStore, reqs []*collogs.ExportLogsServiceRequest) []mappedEvent {
	t.Helper()
	var all []mappedEvent
	for _, req := range reqs {
		events, _, _ := mapAll(t, d, []*collogs.ExportLogsServiceRequest{req})
		store.applyAsWorker(t, events)
		all = append(all, events...)
	}
	return all
}

func recordTime(r *logspb.LogRecord) time.Time {
	return time.Unix(0, int64(r.GetTimeUnixNano())).UTC() //nolint:gosec // a 2026 timestamp
}

// childRecords are the records of the recorded resume's sub-agent of the
// given type, in the order Claude Code emitted them.
func childRecords(t *testing.T, name string) []*logspb.LogRecord {
	t.Helper()
	var out []*logspb.LogRecord
	for _, r := range recordsOf(ccLogRequests(t, "subagent-resume-json")) {
		a := newOTLPAttrs(r.GetAttributes())
		if a.text("agent_id") == ccResumeAgentID && a.text("event.name") == name {
			out = append(out, r)
		}
	}
	if len(out) == 0 {
		t.Fatalf("no sub-agent %s in the resume fixture", name)
	}
	return out
}

// firstEnd is the date of the recorded sub-agent's first
// subagent_completed: the end its resumed run follows.
func firstEnd(t *testing.T) time.Time {
	t.Helper()
	return recordTime(childRecords(t, "subagent_completed")[0])
}

// childCallAt is the recorded sub-agent's first model call, dated at
// (its event id derives from the date, so each date is its own record),
// with agentID as its sub-agent.
func childCallAt(t *testing.T, at time.Time, agentID string) *logspb.LogRecord {
	t.Helper()
	r := proto.Clone(childRecords(t, "api_request")[0]).(*logspb.LogRecord)
	nanos := uint64(at.UnixNano()) //nolint:gosec // a 2026 timestamp
	r.TimeUnixNano, r.ObservedTimeUnixNano = nanos, nanos
	r.TraceId, r.SpanId = nil, nil
	setAttr(r, "agent_id", strVal(agentID))
	return r
}

// exportOf is one log export holding records, under the resume
// fixture's resource and scope.
func exportOf(t *testing.T, records ...*logspb.LogRecord) *collogs.ExportLogsServiceRequest {
	t.Helper()
	first := ccLogRequests(t, "subagent-resume-json")[0]
	return &collogs.ExportLogsServiceRequest{ResourceLogs: []*logspb.ResourceLogs{{
		Resource: first.ResourceLogs[0].Resource,
		ScopeLogs: []*logspb.ScopeLogs{{
			Scope:      first.ResourceLogs[0].ScopeLogs[0].Scope,
			LogRecords: records,
		}},
	}}}
}

// sessionEvents are the types of the events published for one session.
func sessionEvents(events []mappedEvent, sessionID string) []string {
	var out []string
	for _, e := range events {
		if e.Session == sessionID {
			out = append(out, e.Type)
		}
	}
	return out
}

// The recorded resume's sub-agent: two runs under one agent_id, each
// ended by its own subagent_completed.
var resumedChildEvents = []string{
	"session_start", "post_call", "tool_call", "post_call", "session_end",
	"session_start", "post_call", "tool_call", "post_call", "session_end",
}

// The recorded SendMessage resume: the sub-agent's second run, dated
// after the subagent_completed that closed it, re-attaches the same
// child session through a synthetic session_start before its first
// record, and its own subagent_completed closes it again.
func TestClaudeCodeResumedSubagentScenario(t *testing.T) {
	store := newFakeStore()
	d := newResumeTestDialect(store)
	events := mapAsWorker(t, d, store, ccLogRequests(t, "subagent-resume-json"))

	root := ccSessionUUID(ccResumeSession, "")
	child := ccSessionUUID(ccResumeSession, ccResumeAgentID)
	for _, e := range events {
		if e.Session != root && e.Session != child {
			t.Errorf("event on unknown session %s", e.Session)
		}
	}
	if got := sessionEvents(events, child); !reflect.DeepEqual(got, resumedChildEvents) {
		t.Fatalf("child events %v, want %v", got, resumedChildEvents)
	}
	if got := sessionEvents(events, root); got[0] != "session_start" || len(ofType(eventsOf(events, root), "session_start")) != 1 {
		t.Errorf("root events %v, want one start first", got)
	}

	// The resume's start precedes the resumed run's first record: its id
	// derives from that record, it is dated a microsecond before it, and
	// it carries the child's identity.
	childEvents := eventsOf(events, child)
	start, resumed := childEvents[5], childEvents[6]
	wantID := identity.UUID5(identity.NamespaceFlightdeck,
		"flightdeck://otlp/claude-code/start/"+child+"/"+resumed.P["id"].(string))
	if start.P["id"] != wantID {
		t.Errorf("resume start id %v, want %s", start.P["id"], wantID)
	}
	startAt, _ := time.Parse(time.RFC3339Nano, start.P["timestamp"].(string))
	resumedAt, _ := time.Parse(time.RFC3339Nano, resumed.P["timestamp"].(string))
	if resumedAt.Sub(startAt) != otlpSessionStartLead {
		t.Errorf("resume start dated %v before its record", resumedAt.Sub(startAt))
	}
	if start.P["parent_session_id"] != root || start.P["agent_role"] != "general-purpose" {
		t.Errorf("resume start parent %v role %v", start.P["parent_session_id"], start.P["agent_role"])
	}
	if !resumedAt.After(firstEnd(t).Add(otlpResumeTolerance)) {
		t.Fatalf("the fixture's resumed run starts %v after its end", resumedAt.Sub(firstEnd(t)))
	}

	// Both runs' model calls are published with their tokens.
	calls := ofType(childEvents, "post_call")
	if len(calls) != len(childRecords(t, "api_request")) {
		t.Errorf("%d child post_calls for %d recorded calls", len(calls), len(childRecords(t, "api_request")))
	}
	for _, c := range calls {
		if num(t, c.P, "tokens_total") <= 0 {
			t.Errorf("child post_call without tokens: %v", c.P["tokens_total"])
		}
	}
	if store.rows[child] != "closed" || !store.ends[child].Equal(recordTime(childRecords(t, "subagent_completed")[1])) {
		t.Errorf("child row %q ended %v, want closed at its second subagent_completed", store.rows[child], store.ends[child])
	}
}

func eventsOf(events []mappedEvent, sessionID string) []mappedEvent {
	var out []mappedEvent
	for _, e := range events {
		if e.Session == sessionID {
			out = append(out, e)
		}
	}
	return out
}

// A request holding a run's subagent_completed and the resumed run's
// records (Claude Code's 5 s default export interval can put both in
// one export) publishes the end, then a start, then the resumed run:
// the end the request just mapped is the one its later records are
// judged against, with no read of the child's end.
func TestClaudeCodeResumeInOneRequest(t *testing.T) {
	var merged collogs.ExportLogsServiceRequest
	for _, req := range ccLogRequests(t, "subagent-resume-json") {
		merged.ResourceLogs = append(merged.ResourceLogs, req.ResourceLogs...)
	}
	store := newFakeStore()
	d := newResumeTestDialect(store)
	events, _, _ := mapAll(t, d, []*collogs.ExportLogsServiceRequest{&merged})

	child := ccSessionUUID(ccResumeSession, ccResumeAgentID)
	if got := sessionEvents(events, child); !reflect.DeepEqual(got, resumedChildEvents) {
		t.Errorf("child events %v, want %v", got, resumedChildEvents)
	}
	if n := len(store.endReadCalls()); n != 0 {
		t.Errorf("%d end reads for a child the request started", n)
	}
}

// A record of a closed sub-agent dated at or before its end plus the
// tolerance is late and starts nothing; one dated past it resumes the
// sub-agent. The record is published either way.
func TestClaudeCodeResumeToleranceEdge(t *testing.T) {
	root := ccSessionUUID(ccResumeSession, "")
	child := ccSessionUUID(ccResumeSession, ccResumeAgentID)
	end := firstEnd(t)
	for _, c := range []struct {
		name  string
		at    time.Time
		start bool
	}{
		{"before the end", end.Add(-2 * time.Second), false},
		{"at the end", end, false},
		{"at the tolerance", end.Add(otlpResumeTolerance), false},
		{"just past the tolerance", end.Add(otlpResumeTolerance + time.Millisecond), true},
		{"seconds after the end", end.Add(5 * time.Second), true},
	} {
		t.Run(c.name, func(t *testing.T) {
			store := newFakeStore()
			store.rows[root], store.rows[child] = "active", "closed"
			store.ends[child] = end
			d := newResumeTestDialect(store)
			events, _, _ := mapAll(t, d, []*collogs.ExportLogsServiceRequest{
				exportOf(t, childCallAt(t, c.at, ccResumeAgentID)),
			})
			want := []string{"post_call"}
			if c.start {
				want = []string{"session_start", "post_call"}
			}
			if got := eventTypes(events); !reflect.DeepEqual(got, want) {
				t.Errorf("published %v, want %v", got, want)
			}
		})
	}
}

// Each record of a closed sub-agent is judged by its own date: in one
// request, a late record before the first resumed one is published
// without a start, the resumed one gets the request's only start, and a
// late record after it lands on the reopened row.
func TestClaudeCodeOneRequestHoldsLateAndResumedRecords(t *testing.T) {
	root := ccSessionUUID(ccResumeSession, "")
	child := ccSessionUUID(ccResumeSession, ccResumeAgentID)
	end := firstEnd(t)
	store := newFakeStore()
	store.rows[root], store.rows[child] = "active", "closed"
	store.ends[child] = end
	d := newResumeTestDialect(store)
	events, rejected, _ := mapAll(t, d, []*collogs.ExportLogsServiceRequest{exportOf(t,
		childCallAt(t, end.Add(-2*time.Second), ccResumeAgentID),
		childCallAt(t, end.Add(5*time.Second), ccResumeAgentID),
		childCallAt(t, end.Add(-time.Second), ccResumeAgentID),
		childCallAt(t, end.Add(6*time.Second), ccResumeAgentID),
	)})
	if rejected != 0 {
		t.Fatalf("%d records rejected", rejected)
	}
	want := []string{"post_call", "session_start", "post_call", "post_call", "post_call"}
	if got := eventTypes(events); !reflect.DeepEqual(got, want) {
		t.Fatalf("published %v, want %v", got, want)
	}
	wantID := identity.UUID5(identity.NamespaceFlightdeck,
		"flightdeck://otlp/claude-code/start/"+child+"/"+events[2].P["id"].(string))
	if events[1].P["id"] != wantID {
		t.Errorf("the start precedes %v, not the first resumed record", events[1].P["id"])
	}
	if calls := store.endReadCalls(); len(calls) != 1 || !reflect.DeepEqual(calls[0], []string{child}) {
		t.Errorf("end reads %v, want one of the child", calls)
	}
}

// A replica that cached a sub-agent still reads its end on every
// request, since another replica may have published it: the resumed
// run reaching the replica that did not see the end re-attaches the
// child, from the read end rather than a second full read. A request
// naming several cached sub-agents reads their ends in one query.
func TestClaudeCodeCachedSubagentReadsItsEnd(t *testing.T) {
	reqs := ccLogRequests(t, "subagent-resume-json")
	endAt := -1
	for i, req := range reqs {
		for _, r := range recordsOf([]*collogs.ExportLogsServiceRequest{req}) {
			if newOTLPAttrs(r.GetAttributes()).text("event.name") == "subagent_completed" && endAt < 0 {
				endAt = i
			}
		}
	}
	if endAt < 1 || endAt+1 >= len(reqs) {
		t.Fatalf("first subagent_completed in request %d of %d", endAt, len(reqs))
	}
	child := ccSessionUUID(ccResumeSession, ccResumeAgentID)
	store := newFakeStore()
	replicaA, replicaB := newResumeTestDialect(store), newResumeTestDialect(store)

	// B maps the first run and caches the child; A maps the export
	// holding its end, which the worker processes; B maps the resumed
	// run.
	first := mapAsWorker(t, replicaB, store, reqs[:endAt])
	ended := mapAsWorker(t, replicaA, store, reqs[endAt:endAt+1])
	if _, ok := replicaB.cache.get(child); !ok || store.rows[child] != "closed" {
		t.Fatalf("setup: B cached %v, child row %q", ok, store.rows[child])
	}
	fullReads := len(store.calls)
	resumed := mapAsWorker(t, replicaB, store, reqs[endAt+1:])

	events := append(append(first, ended...), resumed...)
	if got := sessionEvents(events, child); !reflect.DeepEqual(got, resumedChildEvents) {
		t.Errorf("child events %v, want %v", got, resumedChildEvents)
	}
	if len(store.calls) != fullReads {
		t.Errorf("B read the cached child again in full: %v", store.calls[fullReads:])
	}

	// Two cached sub-agents named in one request: one read of both ends.
	other := ccSessionUUID(ccResumeSession, "b1c2d3e4f5a6b7c8d")
	at := firstEnd(t).Add(-3 * time.Second)
	mapAll(t, replicaB, []*collogs.ExportLogsServiceRequest{exportOf(t, childCallAt(t, at, "b1c2d3e4f5a6b7c8d"))})
	before := len(store.endReadCalls())
	mapAll(t, replicaB, []*collogs.ExportLogsServiceRequest{exportOf(t,
		childCallAt(t, at.Add(time.Millisecond), ccResumeAgentID),
		childCallAt(t, at.Add(2*time.Millisecond), "b1c2d3e4f5a6b7c8d"),
	)})
	calls := store.endReadCalls()[before:]
	want := []string{child, other}
	if other < child {
		want = []string{other, child}
	}
	if len(calls) != 1 || !reflect.DeepEqual(calls[0], want) {
		t.Errorf("end reads %v, want one of %v", calls, want)
	}
}

// A resumed record mapped before the worker has processed the end it
// follows finds the row open and gets no start: the documented limit,
// which the next record mapped once the end is processed recovers.
func TestClaudeCodeResumeBeforeTheEndIsProcessed(t *testing.T) {
	root := ccSessionUUID(ccResumeSession, "")
	child := ccSessionUUID(ccResumeSession, ccResumeAgentID)
	end := firstEnd(t)
	store := newFakeStore()
	store.rows[root], store.rows[child] = "active", "active" // the end is still queued
	d := newResumeTestDialect(store)
	early, _, _ := mapAll(t, d, []*collogs.ExportLogsServiceRequest{exportOf(t, childCallAt(t, end.Add(4*time.Second), ccResumeAgentID))})
	if got := eventTypes(early); !reflect.DeepEqual(got, []string{"post_call"}) {
		t.Fatalf("published %v before the end was processed", got)
	}
	store.rows[child], store.ends[child] = "closed", end // the worker processes the end
	later, _, _ := mapAll(t, d, []*collogs.ExportLogsServiceRequest{exportOf(t, childCallAt(t, end.Add(6*time.Second), ccResumeAgentID))})
	if got := eventTypes(later); !reflect.DeepEqual(got, []string{"session_start", "post_call"}) {
		t.Errorf("published %v once the end was processed", got)
	}
}

// The worker closes a row before it stores the end's event. Read in that
// moment, a sub-agent's latest stored end is the previous run's (or
// none) while the current run's start is stored after it, and the store
// answers the row's ended_at instead (the worker's clock, later than the
// end): a late record of the current run starts nothing, and a record
// past ended_at and the tolerance resumes the sub-agent.
func TestClaudeCodeEndBeingStoredJudgesByEndedAt(t *testing.T) {
	root := ccSessionUUID(ccResumeSession, "")
	child := ccSessionUUID(ccResumeSession, ccResumeAgentID)
	firstRunEnd := firstEnd(t)
	runStart := firstRunEnd.Add(4500 * time.Millisecond) // the resumed run's start
	runEnd := runStart.Add(2 * time.Second)              // its subagent_completed
	endedAt := runEnd.Add(800 * time.Millisecond)        // the worker's close
	for _, c := range []struct {
		name   string
		starts []time.Time // stored session_starts
		ends   []time.Time // stored session_ends
		late   time.Time   // a record of the run that just ended
	}{
		{"a resumed run", []time.Time{firstRunEnd.Add(-4 * time.Second), runStart}, []time.Time{firstRunEnd}, runStart.Add(1500 * time.Millisecond)},
		{"a first run", []time.Time{runStart}, nil, runStart.Add(1500 * time.Millisecond)},
	} {
		t.Run(c.name, func(t *testing.T) {
			for _, rec := range []struct {
				at    time.Time
				start bool
			}{
				{c.late, false},
				{endedAt.Add(otlpResumeTolerance), false},
				{endedAt.Add(otlpResumeTolerance + time.Millisecond), true},
			} {
				store := newFakeStore()
				store.rows[root], store.rows[child] = "active", "closed"
				store.endedAt[child] = endedAt
				for _, at := range c.starts {
					store.starts[child] = at
				}
				for _, at := range c.ends {
					store.ends[child] = at
				}
				d := newResumeTestDialect(store)
				events, _, _ := mapAll(t, d, []*collogs.ExportLogsServiceRequest{
					exportOf(t, childCallAt(t, rec.at, ccResumeAgentID)),
				})
				if got := len(ofType(events, "session_start")) == 1; got != rec.start {
					t.Errorf("record at ended_at%+v: start %v, want %v", rec.at.Sub(endedAt), got, rec.start)
				}
			}
		})
	}
}

// A record the receiver dated (it carries neither time_unix_nano nor
// observed_time_unix_nano) never starts a closed sub-agent: its date is
// the receiver's clock, not Claude Code's. A missing child is still
// started by it.
func TestClaudeCodeReceiverDatedRecordDoesNotResume(t *testing.T) {
	root := ccSessionUUID(ccResumeSession, "")
	child := ccSessionUUID(ccResumeSession, ccResumeAgentID)
	undated := childCallAt(t, firstEnd(t), ccResumeAgentID)
	undated.TimeUnixNano, undated.ObservedTimeUnixNano = 0, 0

	store := newFakeStore()
	store.rows[root], store.rows[child] = "active", "closed"
	store.ends[child] = firstEnd(t).Add(-time.Hour) // long before the receiver's clock
	d := newResumeTestDialect(store)
	events, rejected, _ := mapAll(t, d, []*collogs.ExportLogsServiceRequest{exportOf(t, undated)})
	if got := eventTypes(events); rejected != 0 || !reflect.DeepEqual(got, []string{"post_call"}) {
		t.Errorf("a receiver-dated record of a closed child published %v (%d rejected)", got, rejected)
	}
	if at := events[0].P["timestamp"]; at != ccResumeFixtureNow.Format(time.RFC3339Nano) {
		t.Errorf("the record is dated %v, want the receiver's clock", at)
	}

	missing := newFakeStore()
	missing.rows[root] = "active"
	d2 := newResumeTestDialect(missing)
	events2, _, _ := mapAll(t, d2, []*collogs.ExportLogsServiceRequest{exportOf(t, undated)})
	if got := eventTypes(events2); !reflect.DeepEqual(got, []string{"session_start", "post_call"}) {
		t.Errorf("a receiver-dated record of a missing child published %v", got)
	}
}

// The end read shares the request's fate: a failed read fails the whole
// request, which publishes nothing.
func TestClaudeCodeEndReadFailureFailsTheRequest(t *testing.T) {
	root := ccSessionUUID(ccResumeSession, "")
	child := ccSessionUUID(ccResumeSession, ccResumeAgentID)
	store := newFakeStore()
	store.rows[root], store.rows[child] = "active", "closed"
	store.endErr = errors.New("db down")
	d := newResumeTestDialect(store)
	m := d.MapLogs(context.Background(), exportOf(t, childCallAt(t, firstEnd(t).Add(5*time.Second), ccResumeAgentID)))
	if !errors.Is(m.Err, store.endErr) || len(m.Events) != 0 || m.Published != nil {
		t.Errorf("Err %v, %d events", m.Err, len(m.Events))
	}
}

// A sub-agent woken by its own background task was never closed (Claude
// Code sends no subagent_completed when it stops with that task
// running), so the woken run continues the open child: one start, one
// end.
func TestClaudeCodeWokenSubagentStaysOneRun(t *testing.T) {
	store := newFakeStore()
	d := newResumeTestDialect(store)
	events := mapAsWorker(t, d, store, ccLogRequests(t, "subagent-wake-json"))
	child := ccSessionUUID(ccWakeSession, ccWakeAgentID)
	want := []string{
		"session_start", "post_call", "tool_call", "post_call",
		"post_call", "tool_call", "post_call", "session_end",
	}
	if got := sessionEvents(events, child); !reflect.DeepEqual(got, want) {
		t.Errorf("child events %v, want %v", got, want)
	}
}

// A resumed sub-agent's synthetic session_start goes out as any other:
// stamped with the token, after the attachment check (which revives the
// closed row), its sequence recorded on the row.
func TestOTLPHandlerResumeStartGoesThroughAttach(t *testing.T) {
	root := ccSessionUUID(ccResumeSession, "")
	child := ccSessionUUID(ccResumeSession, ccResumeAgentID)
	end := firstEnd(t)
	store := newFakeStore()
	store.rows[root], store.rows[child] = "active", "closed"
	store.ends[child] = end
	d := newResumeTestDialect(store)
	pub := &recordingPublisher{}
	att := &fakeAttacher{prior: "closed"}
	h := OTLPLogsHandler(tokenValidator{}, pub, att, d, nil)

	late, err := proto.Marshal(exportOf(t, childCallAt(t, end.Add(-time.Second), ccResumeAgentID)))
	if err != nil {
		t.Fatal(err)
	}
	if w := postOTLP(h, otlpMediaProtobuf, false, late); w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if len(att.attached) != 0 || !reflect.DeepEqual(pub.subjects, []string{"events.post_call"}) {
		t.Fatalf("a late record attached %v, published %v", att.attached, pub.subjects)
	}

	resumed, err := proto.Marshal(exportOf(t, childCallAt(t, end.Add(5*time.Second), ccResumeAgentID)))
	if err != nil {
		t.Fatal(err)
	}
	if w := postOTLP(h, otlpMediaProtobuf, false, resumed); w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if want := []string{"events.post_call", "events.session_start", "events.post_call"}; !reflect.DeepEqual(pub.subjects, want) {
		t.Fatalf("published %v, want %v", pub.subjects, want)
	}
	var start map[string]any
	if err := json.Unmarshal(pub.bodies[1], &start); err != nil {
		t.Fatal(err)
	}
	if start["session_id"] != child || start["token_id"] != "token-id-1" {
		t.Errorf("resume start session %v token %v", start["session_id"], start["token_id"])
	}
	if !reflect.DeepEqual(att.attached, []string{child}) || att.recorded[child] != 102 {
		t.Errorf("attached %v, recorded %v", att.attached, att.recorded)
	}
}
