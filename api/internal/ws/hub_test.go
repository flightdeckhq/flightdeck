package ws

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// fakeStore serves the reads the hub makes per notification. The
// embedded nil Querier makes any other call panic, so a test fails
// loudly if the hub starts reading something else.
type fakeStore struct {
	store.Querier
	sessions        map[string]*store.Session
	events          map[string]*store.Event
	eventReads      []string
	agentStates     map[string]string
	agentStateErr   error
	agentStateReads []string
}

func (f *fakeStore) GetSession(_ context.Context, id string) (*store.Session, error) {
	return f.sessions[id], nil
}

func (f *fakeStore) GetEvent(_ context.Context, id string) (*store.Event, error) {
	f.eventReads = append(f.eventReads, id)
	return f.events[id], nil
}

func (f *fakeStore) GetAgentState(_ context.Context, agentID string) (string, error) {
	f.agentStateReads = append(f.agentStateReads, agentID)
	if f.agentStateErr != nil {
		return "", f.agentStateErr
	}
	return f.agentStates[agentID], nil
}

const (
	testSessionID = "5e6f7a8b-0000-4000-8000-000000000001"
	testEventID   = "5e6f7a8b-0000-4000-8000-0000000000e1"
	testAgentID   = "5e6f7a8b-0000-4000-8000-0000000000a1"
)

// decoded is the broadcast as a dashboard reads it.
type decoded struct {
	Type       string `json:"type"`
	AgentState string `json:"agent_state"`
	Session    struct {
		SessionID string     `json:"session_id"`
		State     string     `json:"state"`
		EndedAt   *time.Time `json:"ended_at"`
	} `json:"session"`
	LastEvent *struct {
		ID        string         `json:"id"`
		EventType string         `json:"event_type"`
		Payload   map[string]any `json:"payload"`
	} `json:"last_event"`
}

func decode(t *testing.T, msg []byte) (decoded, map[string]json.RawMessage) {
	t.Helper()
	if msg == nil {
		t.Fatal("fleetMessage returned nil, want a broadcast")
	}
	var d decoded
	if err := json.Unmarshal(msg, &d); err != nil {
		t.Fatalf("decode broadcast %s: %v", msg, err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(msg, &raw); err != nil {
		t.Fatalf("decode broadcast keys %s: %v", msg, err)
	}
	return d, raw
}

func sessionIn(state string, endedAt *time.Time) *store.Session {
	agentID := testAgentID
	return &store.Session{
		SessionID:  testSessionID,
		Flavor:     "hub-test",
		AgentType:  "coding",
		AgentID:    &agentID,
		State:      state,
		StartedAt:  time.Now().Add(-time.Hour),
		LastSeenAt: time.Now().Add(-31 * time.Minute),
		EndedAt:    endedAt,
	}
}

// The reconciler's state-only notification (no event) becomes a
// session_update carrying the re-read session and no last_event,
// without an event read.
func TestFleetMessage_StateOnlyChangeIsASessionUpdateWithoutAnEvent(t *testing.T) {
	for name, payload := range map[string]string{
		"empty event fields":   `{"session_id":"` + testSessionID + `","event_type":"","event_id":""}`,
		"event fields omitted": `{"session_id":"` + testSessionID + `"}`,
	} {
		t.Run(name, func(t *testing.T) {
			fs := &fakeStore{sessions: map[string]*store.Session{testSessionID: sessionIn("lost", nil)}}
			h := NewHub(fs)

			d, raw := decode(t, h.fleetMessage(context.Background(), payload))
			if d.Type != msgTypeSessionUpdate {
				t.Errorf("type = %q, want %q", d.Type, msgTypeSessionUpdate)
			}
			if d.Session.SessionID != testSessionID || d.Session.State != "lost" {
				t.Errorf("session = %+v, want %s in state lost", d.Session, testSessionID)
			}
			if _, ok := raw["last_event"]; ok {
				t.Errorf("broadcast carries last_event %s, want none for a state-only change", raw["last_event"])
			}
			if len(fs.eventReads) != 0 {
				t.Errorf("hub read events %v, want none", fs.eventReads)
			}
		})
	}
}

// The reaper's notification names its synthetic session_end, so the
// close reaches the dashboard as a session_end with that event and the
// closed session's ended_at.
func TestFleetMessage_ReapedCloseIsASessionEndWithItsEvent(t *testing.T) {
	ended := time.Now().UTC().Truncate(time.Second)
	fs := &fakeStore{
		sessions: map[string]*store.Session{testSessionID: sessionIn("closed", &ended)},
		events: map[string]*store.Event{testEventID: {
			ID:         testEventID,
			SessionID:  testSessionID,
			EventType:  "session_end",
			Payload:    map[string]any{"close_reason": "orphan_timeout"},
			OccurredAt: ended,
		}},
	}
	h := NewHub(fs)

	payload := `{"session_id":"` + testSessionID + `","event_type":"session_end","event_id":"` + testEventID + `"}`
	d, _ := decode(t, h.fleetMessage(context.Background(), payload))
	if d.Type != msgTypeSessionEnd {
		t.Errorf("type = %q, want %q", d.Type, msgTypeSessionEnd)
	}
	if d.Session.State != "closed" || d.Session.EndedAt == nil || !d.Session.EndedAt.Equal(ended) {
		t.Errorf("session = %+v, want closed with ended_at %s", d.Session, ended)
	}
	if d.LastEvent == nil || d.LastEvent.ID != testEventID || d.LastEvent.EventType != "session_end" {
		t.Fatalf("last_event = %+v, want the synthetic session_end %s", d.LastEvent, testEventID)
	}
	if got := d.LastEvent.Payload["close_reason"]; got != "orphan_timeout" {
		t.Errorf("last_event close_reason = %v, want orphan_timeout", got)
	}
}

// An event write keeps its existing shape: the event and its session.
func TestFleetMessage_EventWriteCarriesItsEvent(t *testing.T) {
	fs := &fakeStore{
		sessions: map[string]*store.Session{testSessionID: sessionIn("active", nil)},
		events: map[string]*store.Event{testEventID: {
			ID: testEventID, SessionID: testSessionID, EventType: "post_call", OccurredAt: time.Now(),
		}},
	}
	h := NewHub(fs)

	payload := `{"session_id":"` + testSessionID + `","event_type":"post_call","event_id":"` + testEventID + `"}`
	d, _ := decode(t, h.fleetMessage(context.Background(), payload))
	if d.Type != msgTypeSessionUpdate || d.Session.State != "active" {
		t.Errorf("got type %q state %q, want session_update active", d.Type, d.Session.State)
	}
	if d.LastEvent == nil || d.LastEvent.ID != testEventID {
		t.Errorf("last_event = %+v, want %s", d.LastEvent, testEventID)
	}
}

// Every broadcast carries the agent's rolled-up state as the agent
// endpoints compute it, so a run going stale reports the agent active
// when another of its runs still is, whatever runs the page holds.
func TestFleetMessage_CarriesTheAgentsRolledUpState(t *testing.T) {
	fs := &fakeStore{
		sessions:    map[string]*store.Session{testSessionID: sessionIn("stale", nil)},
		agentStates: map[string]string{testAgentID: "active"},
	}
	d, _ := decode(t, NewHub(fs).fleetMessage(context.Background(), `{"session_id":"`+testSessionID+`"}`))
	if d.Session.State != "stale" || d.AgentState != "active" {
		t.Errorf("session state %q, agent_state %q; want stale and active", d.Session.State, d.AgentState)
	}
	if len(fs.agentStateReads) != 1 || fs.agentStateReads[0] != testAgentID {
		t.Errorf("agent state reads = %v, want one for %s", fs.agentStateReads, testAgentID)
	}
}

// A session with no agent carries no agent_state, and a failed read
// still sends the session update, without the field.
func TestFleetMessage_AgentStateIsOmittedWhenUnknown(t *testing.T) {
	noAgent := sessionIn("stale", nil)
	noAgent.AgentID = nil
	fs := &fakeStore{sessions: map[string]*store.Session{testSessionID: noAgent}}
	_, raw := decode(t, NewHub(fs).fleetMessage(context.Background(), `{"session_id":"`+testSessionID+`"}`))
	if _, ok := raw["agent_state"]; ok {
		t.Errorf("agent_state %s sent for a session without an agent", raw["agent_state"])
	}
	if len(fs.agentStateReads) != 0 {
		t.Errorf("read agent state %v for a session without an agent", fs.agentStateReads)
	}

	failing := &fakeStore{
		sessions:      map[string]*store.Session{testSessionID: sessionIn("stale", nil)},
		agentStateErr: errors.New("connection reset"),
	}
	d, raw := decode(t, NewHub(failing).fleetMessage(context.Background(), `{"session_id":"`+testSessionID+`"}`))
	if d.Session.State != "stale" {
		t.Errorf("session state = %q, want the update sent anyway", d.Session.State)
	}
	if _, ok := raw["agent_state"]; ok {
		t.Errorf("agent_state %s sent although its read failed", raw["agent_state"])
	}
}

// Payloads the hub cannot resolve broadcast nothing.
func TestFleetMessage_NothingToSend(t *testing.T) {
	for name, payload := range map[string]string{
		"not json":             `{session`,
		"no session id":        `{"event_type":"post_call"}`,
		"unknown session":      `{"session_id":"5e6f7a8b-0000-4000-8000-00000000ffff"}`,
		"event not yet stored": `{"session_id":"` + testSessionID + `","event_type":"post_call","event_id":"5e6f7a8b-0000-4000-8000-00000000eeee"}`,
	} {
		t.Run(name, func(t *testing.T) {
			fs := &fakeStore{sessions: map[string]*store.Session{testSessionID: sessionIn("active", nil)}}
			if msg := NewHub(fs).fleetMessage(context.Background(), payload); msg != nil {
				t.Errorf("fleetMessage(%s) = %s, want nil", payload, msg)
			}
		})
	}
}

// The directive-registration sentinel becomes a directives_changed
// message without a store read.
func TestFleetMessage_DirectiveSentinel(t *testing.T) {
	msg := NewHub(&fakeStore{}).fleetMessage(context.Background(), store.NotifyDirectiveRegistered)
	var got map[string]string
	if err := json.Unmarshal(msg, &got); err != nil {
		t.Fatalf("decode %s: %v", msg, err)
	}
	if got["type"] != msgTypeDirectivesChange {
		t.Errorf("type = %q, want %q", got["type"], msgTypeDirectivesChange)
	}
}
