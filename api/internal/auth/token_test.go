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

// envMapFn supports tests that need to set multiple env vars, e.g. the
// admin-token env path which reads FLIGHTDECK_ADMIN_ACCESS_TOKEN alongside
// ENVIRONMENT. Keys absent from the map read as "".
func envMapFn(vars map[string]string) envLookup {
	return func(key string) string {
		return vars[key]
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

// --- Admin scope (Phase 3-bis) ---

func TestValidate_TokAdminDev_AcceptedInDevModeWithIsAdmin(t *testing.T) {
	db := &fakeDB{devRow: &fakeRow{id: "dev-uuid", name: "Development Token"}}
	v := newValidatorWithDB(db, envFn("dev"))

	res, err := v.Validate(context.Background(), "tok_admin_dev")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !res.Valid {
		t.Fatalf("expected valid, got %+v", res)
	}
	if !res.IsAdmin {
		t.Errorf("tok_admin_dev must set IsAdmin=true, got %+v", res)
	}
}

func TestValidate_TokAdminDev_RejectedWhenEnvNotDev(t *testing.T) {
	v := newValidatorWithDB(&fakeDB{}, envFn(""))
	res, _ := v.Validate(context.Background(), "tok_admin_dev")
	if res.Valid {
		t.Fatalf("expected reject, got %+v", res)
	}
	if !strings.Contains(res.Reason, "only valid in development mode") {
		t.Errorf("expected dev-mode reject reason, got %q", res.Reason)
	}
}

func TestValidate_TokDev_DoesNotGrantAdmin(t *testing.T) {
	db := &fakeDB{devRow: &fakeRow{id: "dev-uuid", name: "Development Token"}}
	v := newValidatorWithDB(db, envFn("dev"))
	res, _ := v.Validate(context.Background(), "tok_dev")
	if !res.Valid {
		t.Fatalf("expected valid, got %+v", res)
	}
	if res.IsAdmin {
		t.Errorf("tok_dev must NOT grant admin; got IsAdmin=true")
	}
}

func TestValidate_AdminEnvToken_AcceptedAsAdmin(t *testing.T) {
	v := newValidatorWithDB(&fakeDB{}, envMapFn(map[string]string{
		"FLIGHTDECK_ADMIN_ACCESS_TOKEN": "prod-admin-secret-123",
	}))
	res, err := v.Validate(context.Background(), "prod-admin-secret-123")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !res.Valid || !res.IsAdmin {
		t.Fatalf("expected valid admin, got %+v", res)
	}
	if res.ID != "admin-env" {
		t.Errorf("expected ID=admin-env, got %q", res.ID)
	}
}

func TestValidate_AdminEnvToken_Mismatch(t *testing.T) {
	v := newValidatorWithDB(&fakeDB{}, envMapFn(map[string]string{
		"FLIGHTDECK_ADMIN_ACCESS_TOKEN": "prod-admin-secret-123",
	}))
	res, _ := v.Validate(context.Background(), "not-the-right-token")
	if res.Valid {
		t.Fatalf("mismatched token must not validate, got %+v", res)
	}
}

func TestValidate_AdminEnvToken_UnsetMeansNoAdminPath(t *testing.T) {
	// When the env var is unset, an empty-string match would let
	// rawToken="" through. Confirm that collapse doesn't happen and
	// the normal "empty token is not valid" path wins.
	v := newValidatorWithDB(&fakeDB{}, envMapFn(map[string]string{}))
	res, _ := v.Validate(context.Background(), "")
	if res.Valid {
		t.Fatalf("empty token must never be valid, got %+v", res)
	}
}

func TestAdminRequired_RejectsNonAdminWith403(t *testing.T) {
	db := &fakeDB{devRow: &fakeRow{id: "dev-uuid", name: "Development Token"}}
	v := newValidatorWithDB(db, envFn("dev"))
	h := AdminRequired(v, http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		t.Error("next must not be called for non-admin token")
	}))

	req := httptest.NewRequest("POST", "/v1/admin/reconcile-agents", nil)
	req.Header.Set("Authorization", "Bearer tok_dev")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("expected 403, got %d (body=%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "admin token required") {
		t.Errorf("expected admin-required body, got %s", w.Body.String())
	}
}

func TestAdminRequired_AcceptsAdminToken(t *testing.T) {
	db := &fakeDB{devRow: &fakeRow{id: "dev-uuid", name: "Development Token"}}
	v := newValidatorWithDB(db, envFn("dev"))
	called := false
	h := AdminRequired(v, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("POST", "/v1/admin/reconcile-agents", nil)
	req.Header.Set("Authorization", "Bearer tok_admin_dev")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if !called {
		t.Error("next must be called for admin token")
	}
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}
}

func TestAdminRequired_RejectsMissingBearer(t *testing.T) {
	v := newValidatorWithDB(&fakeDB{}, envFn("dev"))
	h := AdminRequired(v, http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		t.Error("next must not be called without bearer")
	}))

	req := httptest.NewRequest("POST", "/v1/admin/reconcile-agents", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 (missing bearer), got %d", w.Code)
	}
}

func TestAdminRequired_IsSupersetOfMiddleware(t *testing.T) {
	// Admin tokens must also pass the plain Middleware gate (i.e.,
	// admin is a superset, not a separate scope). Regression guard
	// for the V-pass decision locked in Phase 3-bis.
	db := &fakeDB{devRow: &fakeRow{id: "dev-uuid", name: "Development Token"}}
	v := newValidatorWithDB(db, envFn("dev"))
	called := false
	h := Middleware(v, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest("GET", "/v1/fleet", nil)
	req.Header.Set("Authorization", "Bearer tok_admin_dev")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if !called || w.Code != http.StatusOK {
		t.Errorf("admin token must pass plain Middleware; got called=%v code=%d", called, w.Code)
	}
}
