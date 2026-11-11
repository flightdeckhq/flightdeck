package storage_test

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"strings"
	"syscall"
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

// PermanentOpenError tells the failures another attempt cannot fix
// from the ones a database that is still starting produces.
func TestPermanentOpenError_Classifies(t *testing.T) {
	wrap := func(err error) error { return fmt.Errorf("storage: ping postgres: %w", err) }
	permanent := map[string]error{
		"unsupported scheme":      storage.ErrUnsupportedURL,
		"sqlite without a file":   wrap(storage.ErrSQLiteNeedsFile),
		"unparsable postgres URL": wrap(storage.ErrInvalidURL),
		"pgx config parse error":  wrap(&pgconn.ParseConfigError{}),
		"wrong password":          wrap(&pgconn.PgError{Severity: "FATAL", Code: "28P01"}),
		"role may not log in":     wrap(&pgconn.PgError{Severity: "FATAL", Code: "28000"}),
		"database does not exist": wrap(&pgconn.PgError{Severity: "FATAL", Code: "3D000"}),
	}
	for name, err := range permanent {
		if !storage.PermanentOpenError(err) {
			t.Errorf("%s (%v) must be permanent", name, err)
		}
	}
	transient := map[string]error{
		"no error":             nil,
		"connection refused":   wrap(&net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}),
		"name not resolved":    wrap(&net.DNSError{Err: "no such host", Name: "postgres", IsNotFound: true}),
		"server starting up":   wrap(&pgconn.PgError{Severity: "FATAL", Code: "57P03"}),
		"too many connections": wrap(&pgconn.PgError{Severity: "FATAL", Code: "53300"}),
		"deadline":             wrap(context.DeadlineExceeded),
		"cancelled":            wrap(context.Canceled),
		"something else":       errors.New("unexpected EOF"),
	}
	for name, err := range transient {
		if storage.PermanentOpenError(err) {
			t.Errorf("%s (%v) must not be permanent", name, err)
		}
	}
}

// postgresURLWith returns the test database's URL with one part
// replaced, for a connection Postgres itself must refuse.
func postgresURLWith(t *testing.T, change func(u *url.URL)) string {
	t.Helper()
	u, err := url.Parse(storagetest.PostgresURL(t))
	if err != nil {
		t.Fatal(err)
	}
	change(u)
	return u.String()
}

// permanentFailureBudget is the budget OpenRetry is given for a failure
// it must not retry. Were it retried, the call would return only when
// the budget ran out; returning within half of it (a refused login
// takes milliseconds) proves it was not.
const permanentFailureBudget = 20 * time.Second

// A wrong password and a database that does not exist are refused by
// Postgres the same way on every attempt: OpenRetry returns the error
// at once instead of waiting out its budget, and the error is
// classified permanent.
func TestOpenRetry_PostgresRefusalIsReturnedAtOnce(t *testing.T) {
	cases := map[string]struct {
		url  string
		code string
	}{
		"wrong password": {
			url: postgresURLWith(t, func(u *url.URL) {
				u.User = url.UserPassword(u.User.Username(), "not-the-password-"+fmt.Sprint(time.Now().UnixNano()))
			}),
			code: "28P01",
		},
		"database does not exist": {
			url:  postgresURLWith(t, func(u *url.URL) { u.Path = "/fd_no_such_database_" + fmt.Sprint(time.Now().UnixNano()) }),
			code: "3D000",
		},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			start := time.Now()
			db, err := storage.OpenRetry(context.Background(), c.url, permanentFailureBudget)
			elapsed := time.Since(start)
			if err == nil {
				_ = db.Close()
				t.Fatal("OpenRetry succeeded")
			}
			if elapsed > permanentFailureBudget/2 {
				t.Errorf("returned after %s: the refusal was retried", elapsed)
			}
			if !storage.PermanentOpenError(err) {
				t.Errorf("error %q is not classified permanent", storage.ErrorClass(err))
			}
			var pgErr *pgconn.PgError
			if !errors.As(err, &pgErr) || pgErr.Code != c.code {
				t.Errorf("error %q, want SQLSTATE %s", storage.ErrorClass(err), c.code)
			}
			if strings.Contains(err.Error(), "not-the-password") {
				t.Errorf("the error repeats the password: %v", err)
			}
		})
	}
}

// A SQLite file that cannot be opened is not retried either: a file is
// not a server that comes up later.
func TestOpenRetry_SQLiteOpenFailureIsReturnedAtOnce(t *testing.T) {
	missing := storage.SQLiteURL(filepath.Join(t.TempDir(), "no-such-dir", "fd.db"))
	start := time.Now()
	db, err := storage.OpenRetry(context.Background(), missing, permanentFailureBudget)
	if err == nil {
		_ = db.Close()
		t.Fatal("OpenRetry opened a database in a directory that does not exist")
	}
	if elapsed := time.Since(start); elapsed > permanentFailureBudget/2 {
		t.Errorf("returned after %s: the failure was retried", elapsed)
	}
	if !storage.PermanentOpenError(err) {
		t.Errorf("error %v is not classified permanent", err)
	}
}

// A Postgres URL that does not parse is refused without its text: the
// parse error would quote the URL, password included.
func TestOpen_UnparsablePostgresURLIsRefusedWithoutItsPassword(t *testing.T) {
	_, err := storage.OpenRetry(context.Background(), "postgres://user:s3cret pass@host:5432/db%zz", permanentFailureBudget)
	if !errors.Is(err, storage.ErrInvalidURL) || !storage.PermanentOpenError(err) {
		t.Fatalf("err = %v, want ErrInvalidURL, permanent", err)
	}
	if strings.Contains(err.Error(), "s3cret") {
		t.Fatalf("the error repeats the password: %v", err)
	}
}
