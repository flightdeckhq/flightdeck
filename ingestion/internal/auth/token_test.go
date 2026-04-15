package auth

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// --- pgx fakes ---

// fakeRow is a single-row stub that scans a fixed (id, name) tuple
// for the tok_dev SELECT branch.
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

// fakeRows iterates a fixed list of (id, name, hash, salt) tuples for
// the ftd_ prefix-lookup branch.
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

// fakeDB drives the four scenarios (tok_dev accept, ftd_ accept, ftd_
// miss, etc.). Each query type has its own canned response and a
// counter so tests can assert call patterns.
type fakeDB struct {
	devRow         *fakeRow      // returned by the tok_dev SELECT
	ftdCandidates  [][4]string   // returned by the ftd_ Query
	devQueryCount  atomic.Int32
	ftdQueryCount  atomic.Int32
	execCount      atomic.Int32
	queryErr       error
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
	if f.queryErr != nil {
		return nil, f.queryErr
	}
	return &fakeRows{rows: f.ftdCandidates}, nil
}

func (f *fakeDB) Exec(_ context.Context, _ string, _ ...any) error {
	f.execCount.Add(1)
	return nil
}

func envFn(value string) envLookup {
	return func(key string) string {
		if key == "ENVIRONMENT" {
			return value
		}
		return ""
	}
}

// --- Scenario 1: tok_dev accepted when ENVIRONMENT=dev ---

func TestValidate_TokDev_AcceptedInDevMode(t *testing.T) {
	db := &fakeDB{devRow: &fakeRow{id: "dev-uuid", name: "Development Token"}}
	v := newValidatorWithDB(db, envFn("dev"))

	res, err := v.Validate(context.Background(), "tok_dev")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !res.Valid {
		t.Fatalf("expected Valid=true, got %+v", res)
	}
	if res.ID != "dev-uuid" || res.Name != "Development Token" {
		t.Errorf("expected (dev-uuid, Development Token), got (%s, %s)", res.ID, res.Name)
	}
	if db.devQueryCount.Load() != 1 {
		t.Errorf("expected 1 dev-row query, got %d", db.devQueryCount.Load())
	}
	if db.execCount.Load() != 1 {
		t.Errorf("expected 1 last_used_at update, got %d", db.execCount.Load())
	}
}

// --- Scenario 2: tok_dev rejected when ENVIRONMENT not set ---

func TestValidate_TokDev_RejectedWhenEnvNotDev(t *testing.T) {
	db := &fakeDB{}
	v := newValidatorWithDB(db, envFn(""))

	res, err := v.Validate(context.Background(), "tok_dev")
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if res.Valid {
		t.Fatalf("expected Valid=false, got %+v", res)
	}
	if !strings.Contains(res.Reason, "tok_dev is only valid in development mode") {
		t.Errorf("expected dev-mode reject reason, got %q", res.Reason)
	}
	if db.devQueryCount.Load() != 0 {
		t.Errorf("rejected tok_dev must not hit the DB, got %d queries", db.devQueryCount.Load())
	}
}

func TestValidate_TokDev_RejectedWhenEnvIsProd(t *testing.T) {
	db := &fakeDB{}
	v := newValidatorWithDB(db, envFn("prod"))

	res, _ := v.Validate(context.Background(), "tok_dev")
	if res.Valid {
		t.Fatalf("expected Valid=false in prod env, got %+v", res)
	}
}

// --- Scenario 3: ftd_ token accepted after creation ---

func TestValidate_FtdToken_AcceptedWithMatchingHash(t *testing.T) {
	rawToken := "ftd_a3f8b00b1234567890abcdef01234567"
	salt := "deadbeefdeadbeefdeadbeefdeadbeef"
	hash := hashWithSalt(salt, rawToken)
	prefix := rawToken[:prefixLen]

	db := &fakeDB{
		ftdCandidates: [][4]string{
			{"prod-uuid", "Production K8s", hash, salt},
		},
	}
	v := newValidatorWithDB(db, envFn(""))

	res, err := v.Validate(context.Background(), rawToken)
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if !res.Valid || res.ID != "prod-uuid" || res.Name != "Production K8s" {
		t.Fatalf("expected accepted ftd_ token, got %+v", res)
	}
	if db.ftdQueryCount.Load() != 1 {
		t.Errorf("expected 1 prefix query for %s, got %d", prefix, db.ftdQueryCount.Load())
	}
	if db.execCount.Load() != 1 {
		t.Errorf("expected 1 last_used_at update, got %d", db.execCount.Load())
	}
}

func TestValidate_FtdToken_RejectedWhenNoCandidate(t *testing.T) {
	db := &fakeDB{ftdCandidates: nil}
	v := newValidatorWithDB(db, envFn(""))

	res, _ := v.Validate(context.Background(), "ftd_unknownsuffixsuffix0123456789")
	if res.Valid {
		t.Errorf("expected Valid=false for unknown ftd_ token, got %+v", res)
	}
	if res.Reason != "" {
		t.Errorf("unknown ftd_ token must not surface a Reason, got %q", res.Reason)
	}
}

func TestValidate_FtdToken_RejectedWhenHashMismatch(t *testing.T) {
	// Candidate row exists for the prefix but the stored hash was
	// derived from a different raw token -- attacker submits a token
	// with the same prefix but the wrong suffix.
	db := &fakeDB{
		ftdCandidates: [][4]string{
			{"prod-uuid", "Real Token", hashWithSalt("salt1", "ftd_realtoken000000000000000000000"), "salt1"},
		},
	}
	v := newValidatorWithDB(db, envFn(""))

	res, _ := v.Validate(context.Background(), "ftd_realtoken000000000000000000xxx")
	if res.Valid {
		t.Errorf("expected Valid=false on hash mismatch, got %+v", res)
	}
}

// --- Scenario 4: invalid token (any other format) rejected ---

func TestValidate_OtherFormat_Rejected(t *testing.T) {
	db := &fakeDB{}
	v := newValidatorWithDB(db, envFn("dev"))

	for _, raw := range []string{"sk-anthropic-test", "Bearer something", "random", ""} {
		res, _ := v.Validate(context.Background(), raw)
		if res.Valid {
			t.Errorf("token %q must be rejected, got %+v", raw, res)
		}
	}
	// Empty / non-prefixed tokens must NOT hit the DB at all.
	if db.devQueryCount.Load() != 0 || db.ftdQueryCount.Load() != 0 {
		t.Errorf("non-tok_dev / non-ftd_ tokens must not hit DB, got dev=%d ftd=%d",
			db.devQueryCount.Load(), db.ftdQueryCount.Load())
	}
}

// --- Cache behavior: re-validating the same token avoids repeat DB I/O ---

func TestValidate_CacheHitAvoidsRepeatDBCall(t *testing.T) {
	db := &fakeDB{devRow: &fakeRow{id: "dev-uuid", name: "Development Token"}}
	v := newValidatorWithDB(db, envFn("dev"))

	for i := 0; i < 3; i++ {
		res, err := v.Validate(context.Background(), "tok_dev")
		if err != nil || !res.Valid {
			t.Fatalf("validate %d failed: %+v err=%v", i, res, err)
		}
	}
	if db.devQueryCount.Load() != 1 {
		t.Errorf("expected 1 DB hit across 3 validates (cache), got %d", db.devQueryCount.Load())
	}
}

func TestValidate_CacheExpiryReQueriesDB(t *testing.T) {
	db := &fakeDB{devRow: &fakeRow{id: "dev-uuid", name: "Development Token"}}
	v := newValidatorWithDB(db, envFn("dev"))

	_, _ = v.Validate(context.Background(), "tok_dev")
	if db.devQueryCount.Load() != 1 {
		t.Fatalf("expected 1 initial DB hit, got %d", db.devQueryCount.Load())
	}
	v.mu.Lock()
	v.cache["tok_dev"] = cacheEntry{
		result:  ValidationResult{Valid: true, ID: "dev-uuid", Name: "Development Token"},
		validAt: time.Now().Add(-2 * cacheTTL),
	}
	v.mu.Unlock()

	_, _ = v.Validate(context.Background(), "tok_dev")
	if db.devQueryCount.Load() != 2 {
		t.Errorf("expected 2 DB hits after expiry, got %d", db.devQueryCount.Load())
	}
}

// Unknown-token rejects must NOT be cached so token rotation /
// creation takes effect immediately.
func TestValidate_UnknownTokenRejectNotCached(t *testing.T) {
	db := &fakeDB{ftdCandidates: nil}
	v := newValidatorWithDB(db, envFn(""))

	for i := 0; i < 3; i++ {
		_, _ = v.Validate(context.Background(), "ftd_unknown000000000000000000000000")
	}
	if db.ftdQueryCount.Load() != 3 {
		t.Errorf("expected 3 DB hits for unknown ftd_ token (no cache), got %d", db.ftdQueryCount.Load())
	}
}
