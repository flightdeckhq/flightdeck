package writer

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// contentionLanes is the worker pool's default size: the number of
// goroutines that write one session at once in the live worker, so the
// test exercises the same contention the pool produces.
const contentionLanes = 10

// contentionTimeout bounds the whole race. The writes take well under a
// second on either backend; a run that approaches the bound is a
// deadlock (a lane holding a transaction while another lane waits for
// the writer), which the test then reports instead of hanging.
const contentionTimeout = 30 * time.Second

// finalRow is the part of a session row the race must leave identical
// on both backends.
type finalRow struct {
	State, Flavor, AgentType, Framework, Model, ClientType, Owner string
	Tokens                                                        int
	Frameworks                                                    []string
	ContextKeys                                                   int
	HasPosture                                                    bool
	Events                                                        int
	TotalSessions                                                 int
	AgentTokens                                                   int64
}

func readFinalRow(t *testing.T, db *storage.DB, sessionID, agentID string) finalRow {
	t.Helper()
	var r finalRow
	var framework, model, clientType, owner *string
	var raw []byte
	var posture *bool
	if err := db.Reader().QueryRowContext(context.Background(), `
		SELECT state, flavor, agent_type, framework, model, client_type, CAST(agent_id AS TEXT),
		       tokens_used, context, capture_prompts
		FROM sessions WHERE session_id = $1`, sessionID,
	).Scan(&r.State, &r.Flavor, &r.AgentType, &framework, &model, &clientType, &owner, &r.Tokens, &raw, &posture); err != nil {
		t.Fatalf("read session: %v", err)
	}
	r.Framework, r.Model, r.ClientType, r.Owner = str(framework), str(model), str(clientType), str(owner)
	r.HasPosture = posture != nil
	var ctx map[string]any
	if err := json.Unmarshal(raw, &ctx); err != nil {
		t.Fatalf("decode context %s: %v", raw, err)
	}
	r.ContextKeys = len(ctx)
	if list, ok := ctx["frameworks"].([]any); ok {
		for _, v := range list {
			r.Frameworks = append(r.Frameworks, fmt.Sprint(v))
		}
	}
	if err := db.Reader().QueryRowContext(context.Background(),
		`SELECT count(*) FROM events WHERE session_id = $1`, sessionID).Scan(&r.Events); err != nil {
		t.Fatal(err)
	}
	if err := db.Reader().QueryRowContext(context.Background(),
		`SELECT total_sessions, total_tokens FROM agents WHERE agent_id = $1`, agentID).Scan(&r.TotalSessions, &r.AgentTokens); err != nil {
		t.Fatal(err)
	}
	return r
}

// Ten lanes write one session at once, as the worker pool does when a
// burst of a session's events is spread over the lanes: a call reaches
// the worker first and lazily creates the row with its framework, then
// session_starts, calls that append the framework, token updates,
// event inserts with content (a transaction each) and parent bumps all
// run concurrently. The final row is the same on both backends: one
// session counted once for its agent, every token counted once, the
// framework label in context.frameworks exactly once, every event
// stored, and the posture the start wrote. On SQLite every write queues
// on the single writer connection, including the transactions, so the
// run also proves no lane ever waits for the writer while holding it.
func TestContention_TenLanesOnOneSessionAgreeOnBothBackends(t *testing.T) {
	var results = map[storage.Backend]finalRow{}
	each(t, func(t *testing.T, db *storage.DB) {
		ctx, cancel := context.WithTimeout(context.Background(), contentionTimeout)
		defer cancel()
		w, _ := newTestWriter(db)
		agent := testAgent(t, w, db, "contention")
		// The child references the parent, so the parent's cleanup is
		// registered first and runs last.
		parentID := newUUID(t)
		trackSession(t, db, parentID)
		sessionID := newUUID(t)
		trackSession(t, db, sessionID)
		if _, err := w.UpsertParentStub(ctx, parentID, time.Now().UTC()); err != nil {
			t.Fatal(err)
		}
		if _, err := w.ReviveOrCreateSession(ctx, sessionID, "contention-test", agent.AgentType,
			"host", "langchain", "gpt-4o-mini", agent, time.Now().UTC(), parentID, "worker"); err != nil {
			t.Fatalf("lazy create: %v", err)
		}

		const perLane = 5
		content := json.RawMessage(`{"provider":"openai","model":"gpt-4o-mini","messages":[{"role":"user","content":"x"}],"response":{"choices":[]}}`)
		var wg sync.WaitGroup
		errs := make(chan error, contentionLanes*perLane*6)
		release := make(chan struct{})
		for lane := 0; lane < contentionLanes; lane++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-release
				for i := 0; i < perLane; i++ {
					step := func(name string, err error) {
						if err != nil {
							errs <- fmt.Errorf("lane %d step %d %s: %w", lane, i, name, err)
						}
					}
					// The attribution result is not counted here: the row was
					// attributed by its lazy creation, which total_sessions
					// below reflects.
					_, err := w.UpsertSession(ctx, sessionID, "contention-test", agent.AgentType,
						"host", "", "", "active", agent.AgentID, agent.ClientType, agent.AgentName,
						[]byte(`{"os":"Linux"}`), "", "", parentID, "worker", true, uint64(lane*perLane+i+1), time.Time{})
					step("upsert session", err)
					step("update from call", w.UpdateSessionFromCall(ctx, sessionID, "gpt-4o-mini", "langchain"))
					step("tokens", w.UpdateTokensUsed(ctx, sessionID, 3))
					step("agent tokens", w.IncrementAgentTokens(ctx, agent.AgentID, 3))
					_, err = w.InsertEventWithContent(ctx, EventRow{
						SessionID: sessionID, Flavor: "contention-test", EventType: "post_call",
						Model: "gpt-4o-mini", HasContent: true, OccurredAt: time.Now().UTC(),
					}, content)
					step("insert event with content", err)
					_, err = w.BumpParentLastSeen(ctx, parentID)
					step("bump parent", err)
					_, err = w.AttributeSession(ctx, parentID, agent)
					step("attribute parent", err)
				}
			}()
		}
		close(release)
		done := make(chan struct{})
		go func() { wg.Wait(); close(done) }()
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatalf("the lanes did not finish within %s: a lane is waiting for the writer it holds", contentionTimeout)
		}
		close(errs)
		for err := range errs {
			t.Error(err)
		}

		// The lazily created row was attributed once (by its creation);
		// the parent stub exactly once by the races on AttributeSession.
		got := readFinalRow(t, db, sessionID, agent.AgentID)
		want := finalRow{
			State: "active", Flavor: "contention-test", AgentType: agent.AgentType,
			Framework: "langchain", Model: "gpt-4o-mini", ClientType: agent.ClientType, Owner: agent.AgentID,
			Tokens:      contentionLanes * perLane * 3,
			Frameworks:  []string{"langchain"},
			ContextKeys: 2, // os and frameworks
			HasPosture:  true,
			Events:      contentionLanes * perLane,
			// The lazy create counted the session; the stub is the
			// parent's row, which the parent's agent (the same agent here)
			// counts when AttributeSession wins once.
			TotalSessions: 1,
			AgentTokens:   int64(contentionLanes * perLane * 3),
		}
		if fmt.Sprintf("%+v", got) != fmt.Sprintf("%+v", want) {
			t.Errorf("final row\n got %+v\nwant %+v", got, want)
		}
		var parentOwner *string
		var parentState string
		if err := db.Reader().QueryRowContext(ctx, `SELECT CAST(agent_id AS TEXT), state FROM sessions WHERE session_id = $1`, parentID).Scan(&parentOwner, &parentState); err != nil {
			t.Fatal(err)
		}
		if str(parentOwner) != agent.AgentID || parentState != "active" {
			t.Errorf("parent stub owner = %s, state = %s; want the agent and active", str(parentOwner), parentState)
		}
		results[db.Backend] = got
	})
	// When the run covers both backends the rows must agree.
	if pg, ok := results[storage.Postgres]; ok {
		if sq, ok := results[storage.SQLite]; ok && fmt.Sprintf("%+v", pg) != fmt.Sprintf("%+v", sq) {
			// Owner and ids differ per run; compare with them blanked.
			pg.Owner, sq.Owner = "", ""
			if fmt.Sprintf("%+v", pg) != fmt.Sprintf("%+v", sq) {
				t.Errorf("backends disagree:\npostgres %+v\nsqlite   %+v", pg, sq)
			}
		}
	}
}
