package storage_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
	"github.com/jackc/pgx/v5/pgconn"
)

// A Postgres error is described by its code and the table and
// constraint it names, after the layers that wrapped it, never by its
// message, detail or context, which quote the value it refused; any
// other error is described as it is.
func TestErrorClass_NamesCodeTableAndConstraintOnly(t *testing.T) {
	pgErr := &pgconn.PgError{
		Severity: "ERROR", Code: "22P05", Message: "unsupported Unicode escape sequence secret-in-message",
		Detail:         `\u0000 cannot be converted to text. secret-in-detail`,
		Where:          `JSON data, line 1: {"gen_ai.tool.call.result":"secret-in-context`,
		TableName:      "otlp_span_content",
		ConstraintName: "otlp_span_content_pkey",
	}
	err := fmt.Errorf("stage genai records: %w", fmt.Errorf("otlpstage: insert content: %w", pgErr))
	got := storage.ErrorClass(err)
	if strings.Contains(got, "secret") {
		t.Errorf("ErrorClass echoed the refused value: %s", got)
	}
	want := "stage genai records: otlpstage: insert content: postgres error SQLSTATE 22P05 table otlp_span_content constraint otlp_span_content_pkey"
	if got != want {
		t.Errorf("ErrorClass = %q, want %q", got, want)
	}
	plain := errors.New("otlpstage: begin stage: context deadline exceeded")
	if got := storage.ErrorClass(plain); got != plain.Error() {
		t.Errorf("ErrorClass of a plain error = %q, want its text", got)
	}
	if storage.ErrorClass(nil) != "" {
		t.Error("ErrorClass(nil) is not empty")
	}
}

// A real write each backend refuses because of its value is described
// without the value: Postgres quotes it in the message, SQLite names the
// constraint and never the value.
func TestErrorClass_RealRefusalNamesNoData(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		const secret = "secret-order-42"
		// A content row for a record that is not staged (its foreign
		// key fails) whose JSON carries the \u0000 escape Postgres
		// refuses in jsonb; either refusal names the table or the
		// constraint, never the document.
		_, err := db.ExecContext(ctx, `
			INSERT INTO otlp_span_content (token_key, trace_id, span_id, kind, content, staged_at)
			VALUES ($1, $2, $3, 1, $4, $5)`,
			"errclass-test", make([]byte, 16), make([]byte, 8), `{"k":"\u0000 `+secret+`"}`, time.Now())
		if err == nil {
			t.Fatal("the insert was accepted")
		}
		if got := storage.ErrorClass(err); strings.Contains(got, secret) || got == "" {
			t.Errorf("ErrorClass = %q quotes the refused value", got)
		}
		if db.Backend == storage.Postgres && !strings.Contains(storage.ErrorClass(err), "SQLSTATE") {
			t.Errorf("ErrorClass = %q does not name the SQLSTATE", storage.ErrorClass(err))
		}
	})
}
