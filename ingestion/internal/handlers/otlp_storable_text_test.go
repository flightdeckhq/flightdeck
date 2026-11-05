package handlers

import (
	"bytes"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/genai"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
	"github.com/jackc/pgx/v5/pgconn"
)

// jsonEscape is the JSON escape of a UTF-16 code unit, built at run time
// so the escape stays text in this file.
func jsonEscape(hex string) string { return "\\" + "u" + hex }

// An event the receiver publishes (a GenAI assembly's, a Claude Code
// record's) has a U+0000 in its content or identity replaced by U+FFFD,
// as POST /v1/events does, so the worker can store it.
func TestFinishOTLPEventReplacesTextPostgresCannotStore(t *testing.T) {
	gt := stageGenAIScenario(t, filepath.Join(genaiFixtureRoot, "pydantic-ai-2.64.0", "tool-protobuf"))[0]
	row := gt.row
	row.Capture = true
	var last int64
	for _, f := range gt.facts {
		last = max(last, f.EndNs)
	}
	now := time.Unix(0, last).Add(time.Minute)
	evs := genai.Resolve(genai.Input{Trace: row, Facts: gt.facts, Reason: otlpstage.ReasonComplete})
	nul := string(rune(0))
	found := false
	for _, ev := range evs {
		if ev.EventType != "tool_call" {
			continue
		}
		found = true
		ev.Payload["content"].(map[string]any)["tool_output"] = "order" + nul + "42"
		ev.Payload["tool_name"] = "get" + nul + "weather"
		body, msg := finishOTLPEvent(ev.Payload, now)
		if msg != "" {
			t.Fatalf("refused: %s", msg)
		}
		if bytes.Contains(body, []byte(jsonEscape("0000"))) || bytes.Count(body, []byte(jsonEscape("fffd"))) != 2 {
			t.Errorf("published %s", body)
		}
	}
	if !found {
		t.Fatal("no tool_call")
	}
}

// A staging write Postgres refuses is logged by its error class: the
// SQLSTATE and table, never the message, detail or context, which quote
// the record's content.
func TestOTLPStagingFailureLogNamesNoContent(t *testing.T) {
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(prev) })

	pgErr := &pgconn.PgError{
		Severity: "ERROR", Code: "22P05", Message: "unsupported Unicode escape sequence secret-message",
		Detail: "secret-detail", Where: `JSON data, line 1: {"gen_ai.tool.call.result":"secret-context`,
		TableName: "otlp_span_content",
	}
	stager := &fakeStager{err: fmt.Errorf("otlpstage: insert content: %w", pgErr)}
	h := OTLPTracesHandler(tokenValidator{}, &recordingPublisher{}, &fakeAttacher{}, newTestRouter(stager), nil)
	if w := postTraces(h, genaiTraceBody(t)); w.code != http.StatusServiceUnavailable {
		t.Fatalf("status %d", w.code)
	}
	got := logs.String()
	if strings.Contains(got, "secret") {
		t.Errorf("the staging failure log quotes content: %s", got)
	}
	if !strings.Contains(got, "otlp staging failed") || !strings.Contains(got, "SQLSTATE 22P05") {
		t.Errorf("the staging failure log does not name the error class: %s", got)
	}
}
