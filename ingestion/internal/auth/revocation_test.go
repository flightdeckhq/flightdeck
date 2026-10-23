package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// revocationTestDeadline bounds how long the DB-backed test waits for a
// deletion to reach the validator. Delivery is a single NOTIFY round
// trip (milliseconds); five seconds leaves room for a loaded CI host
// while staying far below the 60 s cacheTTL the test proves is bypassed.
const revocationTestDeadline = 5 * time.Second

func cachedIDs(v *Validator) map[string]int {
	v.mu.RLock()
	defer v.mu.RUnlock()
	out := map[string]int{}
	for _, e := range v.cache {
		out[e.result.ID]++
	}
	return out
}

func TestInvalidate_DropsOnlyTheRevokedToken(t *testing.T) {
	saltA, saltB := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	rawA, rawB := "ftd_a3f8b00b1234567890abcdef01234567", "ftd_a3f8b00b7654321098fedcba76543210"
	db := &fakeDB{ftdCandidates: [][4]string{
		{"token-a", "A", hashWithSalt(saltA, rawA), saltA},
		{"token-b", "B", hashWithSalt(saltB, rawB), saltB},
	}}
	v := newValidatorWithDB(db, envFn(""))
	for _, raw := range []string{rawA, rawB} {
		if res, err := v.Validate(context.Background(), raw); err != nil || !res.Valid {
			t.Fatalf("prime %s: %+v err=%v", raw, res, err)
		}
	}

	v.Invalidate("token-a")

	ids := cachedIDs(v)
	if ids["token-a"] != 0 || ids["token-b"] != 1 {
		t.Fatalf("after Invalidate(token-a) cache holds %v, want only token-b", ids)
	}
	// The next request with A goes back to the database.
	before := db.ftdQueryCount.Load()
	_, _ = v.Validate(context.Background(), rawA)
	if db.ftdQueryCount.Load() != before+1 {
		t.Errorf("revoked token was answered from the cache")
	}
}

// blockingDB holds the ftd_ lookup until release is closed, so a test
// can revoke a token while a validation of it is mid-query.
type blockingDB struct {
	*fakeDB
	started chan struct{}
	release chan struct{}
}

func (b *blockingDB) Query(ctx context.Context, sql string, args ...any) (pgxRows, error) {
	close(b.started)
	<-b.release
	return b.fakeDB.Query(ctx, sql, args...)
}

// A lookup that read the token row before it was deleted must not
// cache its (now stale) Valid result once the revocation has been
// processed; otherwise the revoked token would be accepted from the
// cache for a full cacheTTL.
func TestInvalidate_DuringLookupKeepsStaleResultOutOfCache(t *testing.T) {
	salt := "dddddddddddddddddddddddddddddddd"
	raw := "ftd_a3f8b00b1234567890abcdef01234567"
	db := &blockingDB{
		fakeDB:  &fakeDB{ftdCandidates: [][4]string{{"token-d", "D", hashWithSalt(salt, raw), salt}}},
		started: make(chan struct{}),
		release: make(chan struct{}),
	}
	v := newValidatorWithDB(db, envFn(""))

	done := make(chan ValidationResult, 1)
	go func() {
		res, _ := v.Validate(context.Background(), raw)
		done <- res
	}()
	<-db.started
	v.Invalidate("token-d")
	close(db.release)
	<-done

	if n := cachedIDs(v)["token-d"]; n != 0 {
		t.Fatalf("stale validation cached after the token was revoked (%d entries)", n)
	}
}

func TestFlush_ClearsEveryEntry(t *testing.T) {
	salt := "cccccccccccccccccccccccccccccccc"
	raw := "ftd_a3f8b00b1234567890abcdef01234567"
	db := &fakeDB{ftdCandidates: [][4]string{{"token-c", "C", hashWithSalt(salt, raw), salt}}}
	v := newValidatorWithDB(db, envFn(""))
	if res, _ := v.Validate(context.Background(), raw); !res.Valid {
		t.Fatal("prime failed")
	}
	v.Flush()
	if n := len(cachedIDs(v)); n != 0 {
		t.Fatalf("cache holds %d entries after Flush", n)
	}
}

// TestListenRevocations_DeletedRowStopsCachedToken runs against a real
// Postgres with migration 000028 applied: a token validated (and
// cached) before its row is deleted must be rejected within
// revocationTestDeadline, not after the 60 s cacheTTL.
func TestListenRevocations_DeletedRowStopsCachedToken(t *testing.T) {
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		dsn = os.Getenv("FLIGHTDECK_POSTGRES_URL")
	}
	if dsn == "" {
		t.Skip("no TEST_POSTGRES_URL or FLIGHTDECK_POSTGRES_URL set; skipping DB test")
	}
	ctx, cancel := context.WithCancel(context.Background())
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		cancel()
		t.Skipf("postgres unavailable, skipping DB test: %v", err)
	}
	if pingErr := pool.Ping(ctx); pingErr != nil {
		pool.Close()
		cancel()
		t.Skipf("postgres unavailable, skipping DB test: %v", pingErr)
	}
	// Cleanups run last-in first-out: the listener stops before the row
	// cleanup and the pool close.
	t.Cleanup(pool.Close)

	secret, saltBytes := make([]byte, 16), make([]byte, 16)
	_, _ = rand.Read(secret)
	_, _ = rand.Read(saltBytes)
	raw := "ftd_" + hex.EncodeToString(secret)
	salt := hex.EncodeToString(saltBytes)
	var id string
	if err := pool.QueryRow(ctx,
		`INSERT INTO access_tokens (name, token_hash, salt, prefix)
		 VALUES ($1, $2, $3, $4) RETURNING id::text`,
		"revocation-test", hashWithSalt(salt, raw), salt, raw[:prefixLen],
	).Scan(&id); err != nil {
		t.Fatalf("insert token: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM access_tokens WHERE id = $1::uuid`, id)
	})

	v := NewValidator(pool)
	listening := make(chan struct{}, 1)
	v.onListening = func() { listening <- struct{}{} }
	stopped := make(chan struct{})
	go func() {
		v.ListenRevocations(ctx, pool)
		close(stopped)
	}()
	t.Cleanup(func() {
		cancel()
		<-stopped
	})
	select {
	case <-listening:
	case <-time.After(revocationTestDeadline):
		t.Fatal("revocation listener never attached")
	}

	if res, err := v.Validate(ctx, raw); err != nil || !res.Valid || res.ID != id {
		t.Fatalf("prime: %+v err=%v", res, err)
	}
	if cachedIDs(v)[id] != 1 {
		t.Fatal("token was not cached after a successful validation")
	}

	if _, err := pool.Exec(ctx, `DELETE FROM access_tokens WHERE id = $1::uuid`, id); err != nil {
		t.Fatalf("delete token: %v", err)
	}

	deadline := time.Now().Add(revocationTestDeadline)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		res, err := v.Validate(ctx, raw)
		if err != nil {
			t.Fatalf("validate after delete: %v", err)
		}
		if !res.Valid {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("token still accepted %s after its row was deleted", revocationTestDeadline)
		}
		<-ticker.C
	}
}
