package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// revocationTestDeadline bounds how long a test waits for a revocation
// to reach the validator. Delivery is a channel send in-process or one
// NOTIFY round trip on Postgres (milliseconds); five seconds leaves room
// for a loaded CI host while staying far below the 60 s cacheTTL the
// tests prove is bypassed.
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
	v := newValidatorWithDB(db, nil, envFn(""))
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

func (b *blockingDB) Query(ctx context.Context, sql string, args ...any) (rowsIter, error) {
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
	v := newValidatorWithDB(db, nil, envFn(""))

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
	v := newValidatorWithDB(db, nil, envFn(""))
	if res, _ := v.Validate(context.Background(), raw); !res.Valid {
		t.Fatal("prime failed")
	}
	v.Flush()
	if n := len(cachedIDs(v)); n != 0 {
		t.Fatalf("cache holds %d entries after Flush", n)
	}
}

// startListener runs ListenRevocations on bus and returns once the
// listener has subscribed (and flushed). The listener stops with ctx.
func startListener(t *testing.T, ctx context.Context, v *Validator, bus storage.Bus) {
	t.Helper()
	listening := make(chan struct{}, 1)
	v.onListening = func() {
		select {
		case listening <- struct{}{}:
		default:
		}
	}
	stopped := make(chan struct{})
	go func() {
		v.ListenRevocations(ctx, bus)
		close(stopped)
	}()
	t.Cleanup(func() {
		select {
		case <-stopped:
		case <-time.After(revocationTestDeadline):
			t.Error("revocation listener did not stop with its context")
		}
	})
	select {
	case <-listening:
	case <-time.After(revocationTestDeadline):
		t.Fatal("revocation listener never subscribed")
	}
}

// waitRejected polls Validate until raw is rejected or the deadline
// passes.
func waitRejected(t *testing.T, ctx context.Context, v *Validator, raw string) {
	t.Helper()
	deadline := time.Now().Add(revocationTestDeadline)
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		res, err := v.Validate(ctx, raw)
		if err != nil {
			t.Fatalf("validate after revocation: %v", err)
		}
		if !res.Valid {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("token still accepted %s after its revocation", revocationTestDeadline)
		}
		<-ticker.C
	}
}

// With an in-process bus and a fake database: a published id drops the
// cached token, and only that one.
func TestListenRevocations_PublishedIDDropsCachedToken(t *testing.T) {
	saltA, saltB := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	rawA, rawB := "ftd_a3f8b00b1234567890abcdef01234567", "ftd_a3f8b00b7654321098fedcba76543210"
	db := &fakeDB{ftdCandidates: [][4]string{
		{"token-a", "A", hashWithSalt(saltA, rawA), saltA},
		{"token-b", "B", hashWithSalt(saltB, rawB), saltB},
	}}
	v := newValidatorWithDB(db, nil, envFn(""))
	bus := storage.NewInProcessBus()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	startListener(t, ctx, v, bus)

	for _, raw := range []string{rawA, rawB} {
		if res, err := v.Validate(ctx, raw); err != nil || !res.Valid {
			t.Fatalf("prime %s: %+v err=%v", raw, res, err)
		}
	}
	if err := bus.Publish(ctx, AccessTokenRevokedChannel, "token-a"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(revocationTestDeadline)
	for cachedIDs(v)["token-a"] != 0 {
		if time.Now().After(deadline) {
			t.Fatal("token-a still cached after its id was published")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if cachedIDs(v)["token-b"] != 1 {
		t.Errorf("token-b was dropped too: %v", cachedIDs(v))
	}
}

// gappyBus fails its first Subscribe when subscribeErr is set, closes
// the first working subscription's channel after one payload (a lost
// LISTEN connection), then behaves like an in-process bus.
type gappyBus struct {
	*storage.InProcessBus
	subscriptions atomic.Int32
	subscribeErr  error
	gapped        atomic.Bool
}

func (b *gappyBus) Subscribe(ctx context.Context, channel string) (<-chan string, error) {
	n := b.subscriptions.Add(1)
	if n == 1 && b.subscribeErr != nil {
		return nil, b.subscribeErr
	}
	inner, err := b.InProcessBus.Subscribe(ctx, channel)
	if err != nil {
		return nil, err
	}
	if !b.gapped.CompareAndSwap(false, true) {
		return inner, nil
	}
	// First working subscription: forward one payload, then close.
	out := make(chan string)
	go func() {
		defer close(out)
		select {
		case p, ok := <-inner:
			if ok {
				out <- p
			}
		case <-ctx.Done():
		}
	}()
	return out, nil
}

// A subscription that closes before the context ends is a gap: the
// listener subscribes again and flushes the whole cache, so a revocation
// published during the gap cannot outlive it.
func TestListenRevocations_ResubscribesAfterAGapAndFlushes(t *testing.T) {
	salt := "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	raw := "ftd_a3f8b00b1234567890abcdef01234567"
	db := &fakeDB{ftdCandidates: [][4]string{{"token-e", "E", hashWithSalt(salt, raw), salt}}}
	v := newValidatorWithDB(db, nil, envFn(""))
	bus := &gappyBus{InProcessBus: storage.NewInProcessBus()}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// The listener's reconnect delay is 2 s; the test waits for the
	// second subscription through onListening instead of sleeping.
	listening := make(chan struct{}, 4)
	v.onListening = func() { listening <- struct{}{} }
	stopped := make(chan struct{})
	go func() {
		v.ListenRevocations(ctx, bus)
		close(stopped)
	}()
	t.Cleanup(func() {
		cancel()
		<-stopped
	})
	<-listening // first subscription

	if res, err := v.Validate(ctx, raw); err != nil || !res.Valid {
		t.Fatalf("prime: %+v err=%v", res, err)
	}
	// One unrelated payload makes the gappy bus close the subscription.
	if err := bus.Publish(ctx, AccessTokenRevokedChannel, "someone-else"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-listening: // resubscribed, cache flushed
	case <-time.After(revocationReconnectDelay + revocationTestDeadline):
		t.Fatal("listener did not resubscribe after its subscription closed")
	}
	if n := len(cachedIDs(v)); n != 0 {
		t.Fatalf("cache holds %d entries after the resubscription flush", n)
	}
	if bus.subscriptions.Load() != 2 {
		t.Errorf("%d subscriptions, want 2", bus.subscriptions.Load())
	}
	// The new subscription delivers: the fake database still has the
	// row, so the proof is the cache entry going away, not a rejection.
	if res, err := v.Validate(ctx, raw); err != nil || !res.Valid {
		t.Fatalf("re-prime: %+v err=%v", res, err)
	}
	if err := bus.Publish(ctx, AccessTokenRevokedChannel, "token-e"); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(revocationTestDeadline)
	for cachedIDs(v)["token-e"] != 0 {
		if time.Now().After(deadline) {
			t.Fatal("token-e still cached after its id was published on the new subscription")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A Subscribe error is retried after the delay, not fatal.
func TestListenRevocations_RetriesAFailedSubscribe(t *testing.T) {
	v := newValidatorWithDB(&fakeDB{}, nil, envFn(""))
	bus := &gappyBus{InProcessBus: storage.NewInProcessBus(), subscribeErr: errors.New("connection refused")}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	listening := make(chan struct{}, 4)
	v.onListening = func() { listening <- struct{}{} }
	stopped := make(chan struct{})
	go func() {
		v.ListenRevocations(ctx, bus)
		close(stopped)
	}()
	t.Cleanup(func() {
		cancel()
		<-stopped
	})
	select {
	case <-listening:
	case <-time.After(revocationReconnectDelay + revocationTestDeadline):
		t.Fatal("listener never subscribed after the first Subscribe failed")
	}
	if bus.subscriptions.Load() != 2 {
		t.Errorf("%d Subscribe calls, want 2 (one failed, one succeeded)", bus.subscriptions.Load())
	}
}

// TestListenRevocations_DeletedRowStopsCachedToken runs against both
// backends: a token validated (and cached) before its row is deleted
// must be rejected within revocationTestDeadline, not after the 60 s
// cacheTTL. On Postgres the delete alone fires migration 000028's
// trigger onto the bus; on SQLite the store that deletes the row
// publishes the id after commit, which the test does in its place.
func TestListenRevocations_DeletedRowStopsCachedToken(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		bus := storage.NewBus(db)

		secret, saltBytes := make([]byte, 16), make([]byte, 16)
		_, _ = rand.Read(secret)
		_, _ = rand.Read(saltBytes)
		raw := "ftd_" + hex.EncodeToString(secret)
		salt := hex.EncodeToString(saltBytes)
		var id string
		if err := db.QueryRowContext(ctx,
			`INSERT INTO access_tokens (name, token_hash, salt, prefix)
			 VALUES ($1, $2, $3, $4) RETURNING CAST(id AS TEXT)`,
			"revocation-test", hashWithSalt(salt, raw), salt, raw[:prefixLen],
		).Scan(&id); err != nil {
			t.Fatalf("insert token: %v", err)
		}
		t.Cleanup(func() {
			_, _ = db.ExecContext(context.Background(), `DELETE FROM access_tokens WHERE id = $1`, id)
		})

		v := NewValidator(db)
		startListener(t, ctx, v, bus)

		if res, err := v.Validate(ctx, raw); err != nil || !res.Valid || res.ID != id {
			t.Fatalf("prime: %+v err=%v", res, err)
		}
		if cachedIDs(v)[id] != 1 {
			t.Fatal("token was not cached after a successful validation")
		}
		// The validation stamped last_used_at through the dialect's Now().
		var touched bool
		if err := db.QueryRowContext(ctx, `SELECT last_used_at IS NOT NULL FROM access_tokens WHERE id = $1`, id).Scan(&touched); err != nil {
			t.Fatal(err)
		}
		if !touched {
			t.Error("last_used_at was not stamped")
		}

		if _, err := db.ExecContext(ctx, `DELETE FROM access_tokens WHERE id = $1`, id); err != nil {
			t.Fatalf("delete token: %v", err)
		}
		if db.Backend == storage.SQLite {
			if err := bus.Publish(ctx, AccessTokenRevokedChannel, id); err != nil {
				t.Fatalf("publish revocation: %v", err)
			}
		}
		waitRejected(t, ctx, v, raw)
	})
}

// tok_dev resolves against the seeded row on both backends when
// ENVIRONMENT=dev.
func TestValidate_TokDev_SeededRowOnBothBackends(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		v := newValidatorWithDB(&sqlQuerier{db: db}, db.Dialect, envFn("dev"))
		res, err := v.Validate(context.Background(), "tok_dev")
		if err != nil || !res.Valid || res.Name != "Development Token" || len(res.ID) != 36 {
			t.Fatalf("tok_dev: %+v err=%v", res, err)
		}
	})
}
