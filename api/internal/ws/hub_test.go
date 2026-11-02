package ws

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
)

// fakeStore serves the two reads the hub makes per notification. The
// embedded nil Querier makes any other call panic, so a test fails
// loudly if the hub starts reading something else.
type fakeStore struct {
	store.Querier
	sessions   map[string]*store.Session
	events     map[string]*store.Event
	eventReads []string
}

func (f *fakeStore) GetSession(_ context.Context, id string) (*store.Session, error) {
	return f.sessions[id], nil
}

func (f *fakeStore) GetEvent(_ context.Context, id string) (*store.Event, error) {
	f.eventReads = append(f.eventReads, id)
	return f.events[id], nil
}

const (
	testSessionID = "5e6f7a8b-0000-4000-8000-000000000001"
	testEventID   = "5e6f7a8b-0000-4000-8000-0000000000e1"
)

// decoded is the broadcast as a dashboard reads it.
type decoded struct {
	Type    string `json:"type"`
	Session struct {
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
	return &store.Session{
		SessionID:  testSessionID,
		Flavor:     "hub-test",
		AgentType:  "coding",
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
