package store_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/auth"
	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// suppliedTestTimeout bounds each test here. They take milliseconds;
// the bound turns a hang into a failure.
const suppliedTestTimeout = 60 * time.Second

// racers is how many callers store one supplied token at once: more
// than the instances of any deployment start together.
const racers = 8

func suppliedRows(t *testing.T, ctx context.Context, db *storage.DB, name string) int {
	t.Helper()
	var n int
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM access_tokens WHERE name = $1", name).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func tokenValid(t *testing.T, ctx context.Context, db *storage.DB, raw string) bool {
	t.Helper()
	res, err := auth.NewValidator(db).Validate(ctx, raw)
	if err != nil {
		t.Fatal(err)
	}
	return res.Valid
}

// A supplied token is stored once however often it is stored, resolves
// like a minted one, and a second supplied token leaves the first valid.
func TestEnsureSuppliedAccessToken_IsIdempotentAndValidates(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx, cancel := context.WithTimeout(context.Background(), suppliedTestTimeout)
		defer cancel()
		const name = "Supplied dashboard token (idempotent test)"
		const first = "ftd_3f9c1e7a5b2d4c6e8f0a1b3c5d7e9f1a"
		const second = "ftd_a1b3c5d7e9f13f9c1e7a5b2d4c6e8f0a"

		if tokenValid(t, ctx, db, first) {
			t.Fatal("the token resolves before it was stored")
		}
		created, err := store.EnsureSuppliedAccessToken(ctx, db, name, first)
		if err != nil || !created {
			t.Fatalf("first store: created=%v err=%v", created, err)
		}
		created, err = store.EnsureSuppliedAccessToken(ctx, db, name, first)
		if err != nil || created {
			t.Fatalf("second store of the same token: created=%v err=%v, want it found", created, err)
		}
		if n := suppliedRows(t, ctx, db, name); n != 1 {
			t.Fatalf("%d rows after storing one token twice, want 1", n)
		}
		if !tokenValid(t, ctx, db, first) {
			t.Fatal("the stored token does not resolve")
		}
		// The stored row has the shape of a minted one and never the
		// plaintext.
		var hash, salt, prefix string
		if err := db.QueryRowContext(ctx, "SELECT token_hash, salt, prefix FROM access_tokens WHERE name = $1", name).Scan(&hash, &salt, &prefix); err != nil {
			t.Fatal(err)
		}
		if len(hash) != 64 || len(salt) != 32 || prefix != first[:8] || hash == first || salt == first {
			t.Fatalf("stored row: hash %d chars, salt %d chars, prefix %q", len(hash), len(salt), prefix)
		}

		// The operator changes the token: the new one is stored, the
		// old one stays valid until it is revoked.
		if created, err := store.EnsureSuppliedAccessToken(ctx, db, name, second); err != nil || !created {
			t.Fatalf("store of a second token: created=%v err=%v", created, err)
		}
		if !tokenValid(t, ctx, db, first) || !tokenValid(t, ctx, db, second) {
			t.Fatal("after the token changed, both the old and the new one must resolve")
		}
		if n := suppliedRows(t, ctx, db, name); n != 2 {
			t.Fatalf("%d rows after two tokens, want 2", n)
		}
		// A token one character off does not resolve.
		if tokenValid(t, ctx, db, first[:len(first)-1]+"b") {
			t.Fatal("a different token with the same prefix resolves")
		}
	})
}

// Instances that start together with one supplied token: every store
// succeeds and one row is left. On Postgres each caller has a pool of
// its own, as each instance has; on SQLite they share the file's one
// writer, as the services of the one process that may open it do.
func TestEnsureSuppliedAccessToken_RacingStoresLeaveOneRow(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx, cancel := context.WithTimeout(context.Background(), suppliedTestTimeout)
		defer cancel()
		const name = "Supplied dashboard token (race test)"
		const raw = "ftd_5d7e9f1a3f9c1e7a5b2d4c6e8f0a1b3c"

		handles := make([]*storage.DB, racers)
		for i := range handles {
			h, err := db.Share(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = h.Close() }()
			handles[i] = h
		}
		var wg sync.WaitGroup
		start := make(chan struct{})
		errs := make([]error, racers)
		created := make([]bool, racers)
		for i, h := range handles {
			wg.Add(1)
			go func() {
				defer wg.Done()
				<-start
				created[i], errs[i] = store.EnsureSuppliedAccessToken(ctx, h, name, raw)
			}()
		}
		close(start)
		wg.Wait()

		inserted := 0
		for i := range errs {
			if errs[i] != nil {
				t.Errorf("caller %d failed: %v", i, errs[i])
			}
			if created[i] {
				inserted++
			}
		}
		if inserted != 1 {
			t.Errorf("%d callers report having stored the row, want exactly 1", inserted)
		}
		if n := suppliedRows(t, ctx, db, name); n != 1 {
			t.Fatalf("%d rows after %d racing stores, want 1", n, racers)
		}
		if !tokenValid(t, ctx, db, raw) {
			t.Fatal("the token does not resolve after the race")
		}
	})
}

func TestEnsureSuppliedAccessToken_RefusesNoNameAndAStub(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		if _, err := store.EnsureSuppliedAccessToken(ctx, db, "", "ftd_3f9c1e7a5b2d4c6e8f0a1b3c5d7e9f1a"); err == nil {
			t.Error("a token with no name was stored")
		}
		if _, err := store.EnsureSuppliedAccessToken(ctx, db, "x", "ftd_"); err == nil {
			t.Error("a value shorter than a token prefix was stored")
		}
	})
}
