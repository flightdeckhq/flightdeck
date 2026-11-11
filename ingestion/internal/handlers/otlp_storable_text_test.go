package handlers

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/genai"
	"github.com/flightdeckhq/flightdeck/ingestion/internal/otlpstage"
	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
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

// A staging write the database refuses is logged by its error class:
// on Postgres the SQLSTATE and table, never the message, detail or
// context, which quote the record's content; on SQLite the constraint,
// which never quotes a value. The error is a real one from each backend
// (a content document with the \u0000 escape, for a record that is not
// staged), wrapped as the store wraps it.
func TestOTLPStagingFailureLogNamesNoContent(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		var logs bytes.Buffer
		prev := slog.Default()
		slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
		t.Cleanup(func() { slog.SetDefault(prev) })

		_, dbErr := db.ExecContext(context.Background(), `
			INSERT INTO otlp_span_content (token_key, trace_id, span_id, kind, content, staged_at)
			VALUES ($1, $2, $3, 1, $4, $5)`,
			"storable-text-test", make([]byte, 16), make([]byte, 8),
			`{"gen_ai.tool.call.result":"`+jsonEscape("0000")+` secret-content"}`, time.Now())
		if dbErr == nil {
			t.Fatal("the database accepted content for a record that is not staged")
		}
		stager := &fakeStager{err: fmt.Errorf("otlpstage: insert content: %w", dbErr)}
		h := OTLPTracesHandler(tokenValidator{}, &recordingPublisher{}, &fakeAttacher{}, newTestRouter(stager), nil)
		if w := postTraces(h, genaiTraceBody(t)); w.code != http.StatusServiceUnavailable {
			t.Fatalf("status %d", w.code)
		}
		got := logs.String()
		if strings.Contains(got, "secret") {
			t.Errorf("the staging failure log quotes content: %s", got)
		}
		if !strings.Contains(got, "otlp staging failed") || !strings.Contains(got, "otlpstage: insert content") {
			t.Errorf("the staging failure log does not name the failed write: %s", got)
		}
		if db.Backend == storage.Postgres && !strings.Contains(got, "SQLSTATE") {
			t.Errorf("the staging failure log does not name the error class: %s", got)
		}
	})
}
