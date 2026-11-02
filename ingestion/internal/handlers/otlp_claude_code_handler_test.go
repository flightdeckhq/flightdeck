package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/auth"
	collogs "go.opentelemetry.io/proto/slim/otlp/collector/logs/v1"
	"google.golang.org/protobuf/encoding/protojson"
)

// tokenValidator accepts every request as the token tok_test.
type tokenValidator struct{}

func (tokenValidator) Validate(context.Context, string) (auth.ValidationResult, error) {
	return auth.ValidationResult{Valid: true, ID: "token-id-1", Name: "ci-exporter"}, nil
}

// recordingPublisher keeps what it published; failAt makes the nth
// publish (1-based) fail.
type recordingPublisher struct {
	mu       sync.Mutex
	subjects []string
	bodies   [][]byte
	failAt   int
}

func (p *recordingPublisher) Publish(subject string, data []byte) (uint64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.failAt != 0 && len(p.subjects)+1 == p.failAt {
		p.failAt = 0
		return 0, errors.New("nats down")
	}
	p.subjects = append(p.subjects, subject)
	p.bodies = append(p.bodies, data)
	return uint64(100 + len(p.subjects)), nil
}

// fakeAttacher reports every session as attached in prior state.
type fakeAttacher struct {
	mu       sync.Mutex
	prior    string
	attached []string
	recorded map[string]uint64
}

func (a *fakeAttacher) Attach(_ context.Context, id string) (bool, string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.attached = append(a.attached, id)
	return a.prior != "", a.prior, nil
}

func (a *fakeAttacher) RecordStart(_ context.Context, id string, seq uint64) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.recorded == nil {
		a.recorded = map[string]uint64{}
	}
	a.recorded[id] = seq
	return nil
}

func fixtureBody(t *testing.T, scenario, file string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(ccFixtureRoot, scenario, file))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// A synthetic session_start goes out as POST /v1/events sends one:
// stamped with the token, after the attachment check, its sequence
// recorded on a row it re-attaches.
func TestOTLPHandlerPublishesSessionStartLikeEvents(t *testing.T) {
	store := newFakeStore()
	d, _ := newTestDialect(store)
	pub := &recordingPublisher{}
	att := &fakeAttacher{prior: "closed"}
	h := OTLPLogsHandler(tokenValidator{}, pub, att, d, nil)

	w := postOTLP(h, otlpMediaJSON, false, fixtureBody(t, "bash-json-prompts", "002-logs.json"))
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if len(pub.bodies) != 2 || pub.subjects[0] != "events.session_start" {
		t.Fatalf("published %v", pub.subjects)
	}
	var start map[string]any
	if err := json.Unmarshal(pub.bodies[0], &start); err != nil {
		t.Fatal(err)
	}
	if start["token_id"] != "token-id-1" || start["token_name"] != "ci-exporter" {
		t.Errorf("session_start token %v %v", start["token_id"], start["token_name"])
	}
	sid := start["session_id"].(string)
	if len(att.attached) != 1 || att.attached[0] != sid || att.recorded[sid] != 101 {
		t.Errorf("attached %v, recorded %v", att.attached, att.recorded)
	}
	var pre map[string]any
	if err := json.Unmarshal(pub.bodies[1], &pre); err != nil {
		t.Fatal(err)
	}
	if _, ok := pre["token_id"]; ok {
		t.Error("a pre_call carries the token")
	}
	if strings.Contains(w.Body.String(), "partialSuccess") {
		t.Errorf("every record was used, yet %s", w.Body)
	}
}

// A session read that fails is a 503 the exporter retries; nothing is
// published or charged.
func TestOTLPHandlerLookupFailureIs503(t *testing.T) {
	store := newFakeStore()
	store.err = errors.New("db down")
	d, _ := newTestDialect(store)
	pub := &recordingPublisher{}
	limiter := NewRateLimiter(100)
	h := OTLPLogsHandler(tokenValidator{}, pub, &fakeAttacher{}, d, limiter)
	w := postOTLP(h, otlpMediaJSON, false, fixtureBody(t, "bash-json-prompts", "003-logs.json"))
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "session lookup failed") {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if got := w.Header().Get("Retry-After"); got == "" {
		t.Error("a 503 for a failed session read carries no Retry-After")
	}
	if len(pub.bodies) != 0 {
		t.Errorf("published %d events", len(pub.bodies))
	}
	if ok, _ := limiter.AllowN("tok", 100); !ok {
		t.Error("a refused request was charged")
	}
}

// A request whose publish fails commits nothing to the session cache:
// its retry starts the session again with the same event.
func TestOTLPHandlerPublishFailureDoesNotCache(t *testing.T) {
	store := newFakeStore()
	d, _ := newTestDialect(store)
	pub := &recordingPublisher{failAt: 2}
	h := OTLPLogsHandler(tokenValidator{}, pub, &fakeAttacher{}, d, nil)
	body := fixtureBody(t, "bash-json-prompts", "002-logs.json")

	if w := postOTLP(h, otlpMediaJSON, false, body); w.Code != http.StatusServiceUnavailable {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if d.cache.len() != 0 {
		t.Fatal("a failed request cached its session")
	}
	firstStart := string(pub.bodies[0])
	if w := postOTLP(h, otlpMediaJSON, false, body); w.Code != http.StatusOK {
		t.Fatalf("retry %d %s", w.Code, w.Body)
	}
	if pub.subjects[1] != "events.session_start" || string(pub.bodies[1]) != firstStart {
		t.Error("the retry did not publish the same session_start")
	}
	if d.cache.len() != 1 {
		t.Errorf("cache holds %d after a published request", d.cache.len())
	}
}

// A request mixing mapped and unmapped records answers 200 with the
// unused records counted in partial_success, encoded as the request.
func TestOTLPHandlerPartialSuccessNamesReasons(t *testing.T) {
	d, _ := newTestDialect(newFakeStore())
	h := OTLPLogsHandler(tokenValidator{}, &recordingPublisher{}, &fakeAttacher{}, d, nil)
	w := postOTLP(h, otlpMediaJSON, false, fixtureBody(t, "bash-json-prompts", "011-logs.json"))
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	resp := &collogs.ExportLogsServiceResponse{}
	if err := protojson.Unmarshal(w.Body.Bytes(), resp); err != nil {
		t.Fatal(err)
	}
	ps := resp.GetPartialSuccess()
	if ps.GetRejectedLogRecords() != 1 || !strings.Contains(ps.GetErrorMessage(), `"claude_code.assistant_response" is not mapped (1)`) {
		t.Errorf("partial_success %v", ps)
	}
}
