package processor

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/flightdeckhq/flightdeck/workers/internal/consumer"
)

func intPtr(v int) *int { return &v }

// streamError is an llm_error's error object for a stream that failed
// after the provider had delivered usage, with the partial counts given.
func streamError(partials map[string]any) json.RawMessage {
	obj := map[string]any{
		"error_type":     "stream_error",
		"provider":       "anthropic",
		"abort_reason":   "error_mid_stream",
		"partial_chunks": 12,
	}
	for k, v := range partials {
		obj[k] = v
	}
	raw, _ := json.Marshal(obj)
	return raw
}

func TestApplyFailedStreamTokens(t *testing.T) {
	both := streamError(map[string]any{"partial_tokens_input": 1500, "partial_tokens_output": 240})
	cases := []struct {
		name      string
		event     consumer.EventPayload
		wantApply bool
		// want is the token fields after the call; nil means left unset.
		wantIn, wantOut, wantTotal *int
	}{
		{
			name:      "partial input and output become the token fields",
			event:     consumer.EventPayload{EventType: "llm_error", Error: both},
			wantApply: true, wantIn: intPtr(1500), wantOut: intPtr(240), wantTotal: intPtr(1740),
		},
		{
			name:      "input only counts output as zero",
			event:     consumer.EventPayload{EventType: "llm_error", Error: streamError(map[string]any{"partial_tokens_input": 900})},
			wantApply: true, wantIn: intPtr(900), wantOut: intPtr(0), wantTotal: intPtr(900),
		},
		{
			name:      "zero partials are stored but add nothing",
			event:     consumer.EventPayload{EventType: "llm_error", Error: streamError(map[string]any{"partial_tokens_input": 0, "partial_tokens_output": 0})},
			wantApply: false, wantIn: intPtr(0), wantOut: intPtr(0), wantTotal: intPtr(0),
		},
		{
			name:  "top-level counts win over the partials",
			event: consumer.EventPayload{EventType: "llm_error", Error: both, TokensTotal: intPtr(0)},
			// The event keeps its own report; the partials are not added.
			wantApply: false, wantTotal: intPtr(0),
		},
		{
			name:  "no partial counts leaves the event alone",
			event: consumer.EventPayload{EventType: "llm_error", Error: streamError(nil)},
		},
		{
			name:  "no error object",
			event: consumer.EventPayload{EventType: "llm_error"},
		},
		{
			name:  "a plain-string error (directive_result shape)",
			event: consumer.EventPayload{EventType: "llm_error", Error: json.RawMessage(`"handler raised"`)},
		},
		{
			name:  "another event type's error object is not read",
			event: consumer.EventPayload{EventType: "tool_call", Error: both},
		},
		{
			name:  "post_call is not touched",
			event: consumer.EventPayload{EventType: "post_call", Error: both},
		},
		{
			name:  "negative partial is not counted",
			event: consumer.EventPayload{EventType: "llm_error", Error: streamError(map[string]any{"partial_tokens_input": -5, "partial_tokens_output": 10})},
		},
		{
			name:  "fractional partial is not counted",
			event: consumer.EventPayload{EventType: "llm_error", Error: streamError(map[string]any{"partial_tokens_input": 1.5})},
		},
		{
			name:  "string partial is not counted",
			event: consumer.EventPayload{EventType: "llm_error", Error: streamError(map[string]any{"partial_tokens_input": "1500"})},
		},
		{
			name: "a sum past the INTEGER column is not counted",
			event: consumer.EventPayload{EventType: "llm_error", Error: streamError(map[string]any{
				"partial_tokens_input": math.MaxInt32, "partial_tokens_output": 1,
			})},
		},
		{
			name: "a sum at the INTEGER column's limit is counted",
			event: consumer.EventPayload{EventType: "llm_error", Error: streamError(map[string]any{
				"partial_tokens_input": math.MaxInt32 - 1, "partial_tokens_output": 1,
			})},
			wantApply: true, wantIn: intPtr(math.MaxInt32 - 1), wantOut: intPtr(1), wantTotal: intPtr(math.MaxInt32),
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := tc.event
			if got := applyFailedStreamTokens(&e); got != tc.wantApply {
				t.Errorf("applied = %v, want %v", got, tc.wantApply)
			}
			check := func(field string, got, want *int) {
				t.Helper()
				switch {
				case want == nil && got != nil:
					t.Errorf("%s = %d, want unset", field, *got)
				case want != nil && got == nil:
					t.Errorf("%s unset, want %d", field, *want)
				case want != nil && *got != *want:
					t.Errorf("%s = %d, want %d", field, *got, *want)
				}
			}
			check("tokens_input", e.TokensInput, tc.wantIn)
			check("tokens_output", e.TokensOutput, tc.wantOut)
			check("tokens_total", e.TokensTotal, tc.wantTotal)
		})
	}
}

// A partial count the token columns cannot hold, a string included, is
// dropped with a warning naming the event, not silently.
func TestApplyFailedStreamTokensWarnsWhenItDropsACount(t *testing.T) {
	var buf bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })

	e := consumer.EventPayload{
		ID: "ev-1", SessionID: "s-1", EventType: "llm_error",
		Error: streamError(map[string]any{"partial_tokens_input": "100"}),
	}
	if applyFailedStreamTokens(&e) || e.TokensTotal != nil {
		t.Fatalf("a string partial count was applied: %v", e.TokensTotal)
	}
	if !strings.Contains(buf.String(), "not counted") || !strings.Contains(buf.String(), "event_id=ev-1") {
		t.Errorf("no warning naming the event: %q", buf.String())
	}
}

// failedStreamFixture is a session of a flightdeck_sensor agent, started
// through Process, for the DB-backed tests.
type failedStreamFixture struct {
	pool      *pgxpool.Pool
	p         *Processor
	agentID   string
	sessionID string
}

func newFailedStreamFixture(t *testing.T, clientType string) failedStreamFixture {
	t.Helper()
	pool := dbPool(t)
	ctx := context.Background()
	f := failedStreamFixture{pool: pool, p: NewProcessor(pool), agentID: randomID(t), sessionID: randomID(t)}
	agentType := "production"
	if clientType == "claude_code" {
		agentType = "coding"
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO agents (agent_id, agent_type, client_type, agent_name, user_name, hostname)
		VALUES ($1::uuid, $2, $3, 'failed-stream-test', 'test', 'test-host')`,
		f.agentID, agentType, clientType); err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM events WHERE session_id = $1::uuid`, f.sessionID)
		_, _ = pool.Exec(ctx, `DELETE FROM sessions WHERE session_id = $1::uuid`, f.sessionID)
		_, _ = pool.Exec(ctx, `DELETE FROM agents WHERE agent_id = $1::uuid`, f.agentID)
	})
	f.process(t, f.event("session_start", clientType, agentType))
	return f
}

func (f failedStreamFixture) event(eventType, clientType, agentType string) consumer.EventPayload {
	return consumer.EventPayload{
		ID: "", SessionID: f.sessionID, EventType: eventType, Flavor: "failed-stream-test",
		AgentID: f.agentID, AgentType: agentType, ClientType: clientType,
		AgentName: "failed-stream-test", User: "test", Hostname: "test-host",
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano),
	}
}

func (f failedStreamFixture) process(t *testing.T, e consumer.EventPayload) {
	t.Helper()
	if err := f.p.Process(context.Background(), e); err != nil {
		t.Fatalf("process %s: %v", e.EventType, err)
	}
}

func (f failedStreamFixture) totals(t *testing.T) (sessionTokens int, agentTokens int64) {
	t.Helper()
	ctx := context.Background()
	if err := f.pool.QueryRow(ctx, `SELECT tokens_used FROM sessions WHERE session_id = $1::uuid`, f.sessionID).Scan(&sessionTokens); err != nil {
		t.Fatalf("read tokens_used: %v", err)
	}
	if err := f.pool.QueryRow(ctx, `SELECT total_tokens FROM agents WHERE agent_id = $1::uuid`, f.agentID).Scan(&agentTokens); err != nil {
		t.Fatalf("read total_tokens: %v", err)
	}
	return sessionTokens, agentTokens
}

type storedError struct {
	in, out, total *int
	billing        *string
	model          *string
}

// deref and derefInt print a nullable column's value, or NULL.
func deref(p *string) string {
	if p == nil {
		return "NULL"
	}
	return *p
}

func derefInt(p *int) string {
	if p == nil {
		return "NULL"
	}
	return strconv.Itoa(*p)
}

func (f failedStreamFixture) storedLLMError(t *testing.T, id string) storedError {
	t.Helper()
	var s storedError
	if err := f.pool.QueryRow(context.Background(), `
		SELECT tokens_input, tokens_output, tokens_total, billing_mode, model
		FROM events WHERE id = $1::uuid`, id).Scan(&s.in, &s.out, &s.total, &s.billing, &s.model); err != nil {
		t.Fatalf("read llm_error row: %v", err)
	}
	return s
}

// The billing mode the sensor stamps on a failed stream's llm_error is
// kept: the session's other calls do not override it, and the client
// type's default does not either.
func TestProcess_FailedStreamKeepsTheBillingModeItCarries(t *testing.T) {
	f := newFailedStreamFixture(t, "flightdeck_sensor")
	call := f.event("post_call", "flightdeck_sensor", "production")
	call.Model, call.BillingMode, call.TokensTotal = "gpt-4o-mini", "metered", intPtr(50)
	f.process(t, call)

	local := f.event("llm_error", "flightdeck_sensor", "production")
	local.ID, local.Model, local.BillingMode = randomID(t), "gpt-4o-mini", "local"
	local.Error = streamError(map[string]any{"partial_tokens_input": 90, "partial_tokens_output": 10})
	f.process(t, local)
	if row := f.storedLLMError(t, local.ID); deref(row.billing) != "local" {
		t.Errorf("billing_mode = %s, want local (the event's own, over the same model's metered call)", deref(row.billing))
	}

	first := newFailedStreamFixture(t, "flightdeck_sensor")
	sub := first.event("llm_error", "flightdeck_sensor", "production")
	sub.ID, sub.Model, sub.BillingMode = randomID(t), "deepseek-r1", "subscription"
	sub.Error = streamError(map[string]any{"partial_tokens_input": 30})
	first.process(t, sub)
	if row := first.storedLLMError(t, sub.ID); deref(row.billing) != "subscription" {
		t.Errorf("billing_mode = %s, want subscription (the event's own, over the client default)", deref(row.billing))
	}
	if s, _ := f.totals(t); s != 50+100 {
		t.Errorf("tokens_used = %d, want %d (the tokens still count)", s, 50+100)
	}
}

// A failed stream's partial tokens reach the session and agent totals
// and the stored row. An event without a billing mode (an older sensor)
// is billed as the session's calls of that model are.
func TestProcess_FailedStreamTokensCountAndTakeTheCallsBillingMode(t *testing.T) {
	f := newFailedStreamFixture(t, "flightdeck_sensor")
	call := f.event("post_call", "flightdeck_sensor", "production")
	call.Model, call.BillingMode, call.TokensTotal = "llama3.1:8b", "local", intPtr(300)
	f.process(t, call)
	other := f.event("post_call", "flightdeck_sensor", "production")
	other.Model, other.BillingMode, other.TokensTotal = "gpt-4o-mini", "metered", intPtr(50)
	f.process(t, other)

	failed := f.event("llm_error", "flightdeck_sensor", "production")
	failed.ID = randomID(t)
	failed.Model = "llama3.1:8b"
	failed.Error = streamError(map[string]any{"partial_tokens_input": 1500, "partial_tokens_output": 240})
	f.process(t, failed)

	if s, a := f.totals(t); s != 300+50+1740 || a != 300+50+1740 {
		t.Errorf("tokens_used = %d, total_tokens = %d, want both %d", s, a, 300+50+1740)
	}
	row := f.storedLLMError(t, failed.ID)
	if row.in == nil || *row.in != 1500 || row.out == nil || *row.out != 240 || row.total == nil || *row.total != 1740 {
		t.Errorf("stored token columns = %s / %s / %s, want 1500 / 240 / 1740", derefInt(row.in), derefInt(row.out), derefInt(row.total))
	}
	// The latest call overall is metered, but the latest of the same
	// model is local: the failed stream is billed as that model's calls.
	if row.billing == nil || *row.billing != "local" {
		t.Errorf("billing_mode = %s, want local (the same model's latest call)", deref(row.billing))
	}
}

// An event without a billing mode (an older sensor): with no call of the
// same model, the latest call of any model sets the
// billing mode; with no call at all, the client type's default does.
func TestProcess_FailedStreamBillingModeFallbacks(t *testing.T) {
	f := newFailedStreamFixture(t, "flightdeck_sensor")
	first := f.event("llm_error", "flightdeck_sensor", "production")
	first.ID, first.Model = randomID(t), "claude-sonnet-4-5"
	first.Error = streamError(map[string]any{"partial_tokens_input": 100, "partial_tokens_output": 10})
	f.process(t, first)
	if row := f.storedLLMError(t, first.ID); row.billing == nil || *row.billing != "metered" {
		t.Errorf("first failed stream billing_mode = %s, want metered (flightdeck_sensor default)", deref(row.billing))
	}

	call := f.event("post_call", "flightdeck_sensor", "production")
	call.Model, call.BillingMode, call.TokensTotal = "gpt-4o-mini", "subscription", intPtr(20)
	f.process(t, call)
	second := f.event("llm_error", "flightdeck_sensor", "production")
	second.ID, second.Model = randomID(t), "claude-sonnet-4-5"
	second.Error = streamError(map[string]any{"partial_tokens_input": 40})
	f.process(t, second)
	if row := f.storedLLMError(t, second.ID); row.billing == nil || *row.billing != "subscription" {
		t.Errorf("second failed stream billing_mode = %s, want subscription (the latest call's)", deref(row.billing))
	}
	if s, _ := f.totals(t); s != 110+20+40 {
		t.Errorf("tokens_used = %d, want %d", s, 110+20+40)
	}

	cc := newFailedStreamFixture(t, "claude_code")
	failed := cc.event("llm_error", "claude_code", "coding")
	failed.ID = randomID(t)
	failed.Error = streamError(map[string]any{"partial_tokens_input": 7})
	cc.process(t, failed)
	if row := cc.storedLLMError(t, failed.ID); row.billing == nil || *row.billing != "subscription" {
		t.Errorf("claude_code failed stream billing_mode = %s, want subscription (its default)", deref(row.billing))
	}
}

// An llm_error without partial tokens, and one that reports its own
// top-level counts, change no total and get no billing mode.
func TestProcess_LLMErrorWithoutPartialTokensCountsNothing(t *testing.T) {
	f := newFailedStreamFixture(t, "flightdeck_sensor")
	plain := f.event("llm_error", "flightdeck_sensor", "production")
	plain.ID, plain.Model = randomID(t), "gpt-4o-mini"
	plain.Error = streamError(nil)
	f.process(t, plain)
	own := f.event("llm_error", "flightdeck_sensor", "production")
	own.ID, own.TokensTotal = randomID(t), intPtr(0)
	own.Error = streamError(map[string]any{"partial_tokens_input": 500})
	f.process(t, own)

	if s, a := f.totals(t); s != 0 || a != 0 {
		t.Errorf("tokens_used = %d, total_tokens = %d, want 0", s, a)
	}
	row := f.storedLLMError(t, plain.ID)
	if row.total != nil || row.billing != nil {
		t.Errorf("plain llm_error stored tokens_total %s, billing_mode %s; want NULL", derefInt(row.total), deref(row.billing))
	}
}

// A failed stream published before its session's end, reaching the
// worker after it, still adds its tokens, as a call does.
func TestProcess_FailedStreamPublishedBeforeTheEndCountsOnAClosedSession(t *testing.T) {
	pool := dbPool(t)
	ctx := context.Background()
	p := NewProcessor(pool)
	agentID := randomID(t)
	if _, err := pool.Exec(ctx, `
		INSERT INTO agents (agent_id, agent_type, client_type, agent_name, user_name, hostname)
		VALUES ($1::uuid, 'production', 'flightdeck_sensor', 'failed-stream-test', 'test', 'test-host')`, agentID); err != nil {
		t.Fatalf("seed agent: %v", err)
	}
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM agents WHERE agent_id = $1::uuid`, agentID) })
	sessionID := seedClosedSession(t, pool, agentID, 500)
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM events WHERE session_id = $1::uuid`, sessionID) })

	failed := consumer.EventPayload{
		ID: randomID(t), SessionID: sessionID, AgentID: agentID, EventType: "llm_error",
		Flavor: "failed-stream-test", AgentType: "production", ClientType: "flightdeck_sensor",
		AgentName: "failed-stream-test", User: "test", Hostname: "test-host",
		Timestamp: time.Now().UTC().Format(time.RFC3339Nano), StreamSeq: 499,
		Error: streamError(map[string]any{"partial_tokens_input": 60, "partial_tokens_output": 6}),
	}
	if err := p.Process(ctx, failed); err != nil {
		t.Fatalf("process llm_error: %v", err)
	}
	var used int
	if err := pool.QueryRow(ctx, `SELECT tokens_used FROM sessions WHERE session_id = $1::uuid`, sessionID).Scan(&used); err != nil {
		t.Fatalf("read tokens_used: %v", err)
	}
	if used != 66 {
		t.Errorf("tokens_used = %d, want 66", used)
	}
}
