package auth

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// fakeRow / fakeRows / fakeDB mirror the ingestion-side test doubles.
// Kept in-package so the rest of the codebase can depend only on the
// real pgxpool-backed Validator.

type fakeRow struct {
	id   string
	name string
	err  error
}

func (r *fakeRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	if len(dest) >= 2 {
		if p, ok := dest[0].(*string); ok {
			*p = r.id
		}
		if p, ok := dest[1].(*string); ok {
			*p = r.name
		}
	}
	return nil
}

type fakeRows struct {
	rows [][4]string
	idx  int
}

func (r *fakeRows) Next() bool { r.idx++; return r.idx <= len(r.rows) }
func (r *fakeRows) Scan(dest ...any) error {
	row := r.rows[r.idx-1]
	for i, p := range dest {
		if i >= len(row) {
			break
		}
		if sp, ok := p.(*string); ok {
			*sp = row[i]
		}
	}
	return nil
}
func (r *fakeRows) Close()     {}
func (r *fakeRows) Err() error { return nil }

type fakeDB struct {
	devRow        *fakeRow
	ftdCandidates [][4]string
	devQueryCount atomic.Int32
	ftdQueryCount atomic.Int32
}

func (f *fakeDB) QueryRow(_ context.Context, sql string, _ ...any) pgxRow {
	if strings.Contains(sql, "Development Token") {
		f.devQueryCount.Add(1)
		if f.devRow == nil {
			return &fakeRow{err: errors.New("no dev row configured")}
		}
		return f.devRow
	}
	return &fakeRow{err: errors.New("unexpected QueryRow")}
}

func (f *fakeDB) Query(_ context.Context, _ string, _ ...any) (pgxRows, error) {
	f.ftdQueryCount.Add(1)
	return &fakeRows{rows: f.ftdCandidates}, nil
}

func (f *fakeDB) Exec(_ context.Context, _ string, _ ...any) error { return nil }

func envFn(value string) envLookup {
	return func(key string) string {
		if key == "ENVIRONMENT" {
			return value
		}
		return ""
	}
}

// --- The four scenarios required by Phase 5 ---

func TestValidate_TokDev_AcceptedInDevMode(t *testing.T) {
	db := &fakeDB{devRow: &fakeRow{id: "dev-uuid", name: "Development Token"}}
	v := newValidatorWithDB(db, envFn("dev"))

	res, err := v.Validate(context.Background(), "tok_dev")
	if err != nil || !res.Valid || res.ID != "dev-uuid" {
		t.Fatalf("expected dev-uuid accept, got %+v err=%v", res, err)
	}
}

func TestValidate_TokDev_RejectedWhenEnvNotDev(t *testing.T) {
	v := newValidatorWithDB(&fakeDB{}, envFn(""))
	res, _ := v.Validate(context.Background(), "tok_dev")
	if res.Valid {
		t.Fatalf("expected reject, got %+v", res)
	}
	if !strings.Contains(res.Reason, "only valid in development mode") {
		t.Errorf("expected dev-mode reject reason, got %q", res.Reason)
	}
}

func TestValidate_FtdToken_AcceptedWithMatchingHash(t *testing.T) {
	raw := "ftd_a3f8b00b1234567890abcdef01234567"
	salt := "deadbeefdeadbeefdeadbeefdeadbeef"
	db := &fakeDB{
		ftdCandidates: [][4]string{
			{"prod-uuid", "Production K8s", hashWithSalt(salt, raw), salt},
		},
	}
	v := newValidatorWithDB(db, envFn(""))
	res, err := v.Validate(context.Background(), raw)
	if err != nil || !res.Valid || res.Name != "Production K8s" {
		t.Fatalf("expected production accept, got %+v err=%v", res, err)
	}
}

func TestValidate_InvalidToken_Rejected(t *testing.T) {
	v := newValidatorWithDB(&fakeDB{}, envFn("dev"))
	for _, raw := range []string{"not-a-token", "sk-real-openai", "", "ftd_badbadbadbadbadbadbadbadbadbad"} {
		res, _ := v.Validate(context.Background(), raw)
		if res.Valid {
			t.Errorf("expected reject for %q, got %+v", raw, res)
		}
	}
}

// --- Middleware behavior ---

func TestMiddleware_RejectsMissingBearer(t *testing.T) {
	v := newValidatorWithDB(&fakeDB{}, envFn("dev"))
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		t.Error("next must not be called without a bearer token")
		w.WriteHeader(http.StatusOK)
	})
	h := Middleware(v, next)

	req := httptest.NewRequest("GET", "/", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestMiddleware_SurfacesTokDevReasonIn401(t *testing.T) {
	v := newValidatorWithDB(&fakeDB{}, envFn(""))
	h := Middleware(v, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer tok_dev")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "only valid in development mode") {
		t.Errorf("expected dev-mode reject in body, got %s", w.Body.String())
	}
}

func TestMiddleware_AcceptsValidToken(t *testing.T) {
	db := &fakeDB{devRow: &fakeRow{id: "dev-uuid", name: "Development Token"}}
	v := newValidatorWithDB(db, envFn("dev"))
	called := false
	h := Middleware(v, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer tok_dev")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if !called {
		t.Error("next handler must be called on valid token")
	}
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

