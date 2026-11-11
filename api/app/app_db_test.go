package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// The lifecycle tests run against a migrated database on every covered
// backend (storagetest.Each); the loops Run starts subscribe to the bus
// and run queries, which a dummy URL cannot serve.

// runTimeout bounds how long a test waits for Run to return after the
// context is cancelled: ShutdownTimeout plus margin for the test box.
const runTimeout = 20 * time.Second

// freeAddr returns a loopback address nothing listens on right now.
func freeAddr(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	return addr
}

// waitHealthy polls GET /health on addr until it answers 200.
func waitHealthy(t *testing.T, addr string) {
	t.Helper()
	deadline := time.Now().Add(runTimeout)
	for time.Now().Before(deadline) {
		resp, err := http.Get(fmt.Sprintf("http://%s/health", addr))
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s did not answer /health within %s", addr, runTimeout)
}

func awaitRun(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(runTimeout):
		t.Fatalf("Run did not return within %s of the context ending", runTimeout)
		return nil
	}
}

func TestRun_StopsOnCancelAndLeavesAnInjectedDBOpen(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		addr := freeAddr(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		a, err := New(ctx, Config{ListenAddr: addr, CORSOrigin: "*", ShutdownTimeout: 10 * time.Second}, Deps{DB: db})
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- a.Run(ctx) }()
		waitHealthy(t, addr)

		cancel()
		if err := awaitRun(t, done); err != nil {
			t.Fatalf("Run returned %v on a cancelled context, want nil", err)
		}
		if err := db.PingContext(context.Background()); err != nil {
			t.Fatalf("the injected database was closed by Run: %v", err)
		}
		if _, err := http.Get(fmt.Sprintf("http://%s/health", addr)); err == nil {
			t.Fatal("the listener is still serving after Run returned")
		}
	})
}

// The flightdeck binary passes the one bus its services share. The
// store publishes on that bus (a deleted token is announced there, so
// the ingestion validator in the same process hears it on SQLite, where
// each bus is private to whoever created it), and Run leaves it open.
func TestRun_PublishesOnTheInjectedBusAndLeavesItOpen(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		bus := storage.NewBus(db)
		t.Cleanup(func() { _ = bus.Close() })
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		a, err := New(ctx, Config{CORSOrigin: "*", ShutdownTimeout: 10 * time.Second}, Deps{DB: db, Bus: bus})
		if err != nil {
			t.Fatal(err)
		}
		if a.ownsBus || a.ownsDB {
			t.Fatalf("ownsBus=%v ownsDB=%v: New owns nothing it was given", a.ownsBus, a.ownsDB)
		}
		revoked, err := bus.Subscribe(ctx, storage.ChannelAccessTokenRevoked)
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- a.Run(ctx) }()

		created, err := a.store.CreateAccessToken(ctx, "injected-bus-test")
		if err != nil {
			t.Fatal(err)
		}
		if err := a.store.DeleteAccessToken(ctx, created.ID); err != nil {
			t.Fatal(err)
		}
		select {
		case id := <-revoked:
			if id != created.ID {
				t.Fatalf("revocation of %q announced, want %q", id, created.ID)
			}
		case <-time.After(runTimeout):
			t.Fatal("the deleted token was not announced on the injected bus")
		}

		cancel()
		if err := awaitRun(t, done); err != nil {
			t.Fatal(err)
		}
		if err := bus.Publish(context.Background(), "storagetest_after_run", "x"); err != nil {
			t.Fatalf("the injected bus was closed by Run: %v", err)
		}
	})
}

func TestRun_ClosesTheDBItOpened(t *testing.T) {
	for _, b := range storagetest.Backends(t) {
		t.Run(string(b), func(t *testing.T) {
			var rawURL string
			switch b {
			case storage.SQLite:
				rawURL = "sqlite://" + filepath.Join(t.TempDir(), "flightdeck.db")
			case storage.Postgres:
				rawURL = storagetest.PostgresURL(t)
			}
			if err := storage.Migrate(context.Background(), rawURL); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			addr := freeAddr(t)
			a, err := New(ctx, Config{ListenAddr: addr, PostgresURL: rawURL, CORSOrigin: "*", ShutdownTimeout: 10 * time.Second}, Deps{})
			if err != nil {
				t.Fatal(err)
			}
			owned, ownedBus := a.db, a.bus
			if !a.ownsBus {
				t.Fatal("New must own the bus it created")
			}
			done := make(chan error, 1)
			go func() { done <- a.Run(ctx) }()
			waitHealthy(t, addr)
			cancel()
			if err := awaitRun(t, done); err != nil {
				t.Fatal(err)
			}
			if a.db != nil || a.ownsDB || a.bus != nil || a.ownsBus {
				t.Fatal("Run must close and forget the database it opened and the bus it created")
			}
			if err := ownedBus.Publish(context.Background(), "storagetest_after_run", "x"); !errors.Is(err, storage.ErrBusClosed) {
				t.Fatalf("publish on the bus Run created: %v, want ErrBusClosed", err)
			}
			if err := owned.PingContext(context.Background()); err == nil {
				t.Fatal("the database Run opened still answers after Run returned")
			}
		})
	}
}

func TestRun_ListenerBindFailureIsReturned(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		busy, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = busy.Close() }()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		a, err := New(ctx, Config{ListenAddr: busy.Addr().String(), CORSOrigin: "*", ShutdownTimeout: 10 * time.Second}, Deps{DB: db})
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- a.Run(ctx) }()
		err = awaitRun(t, done)
		if err == nil || !strings.Contains(err.Error(), "query API server") {
			t.Fatalf("Run on a busy port returned %v, want the listener's error", err)
		}
		if err := db.PingContext(context.Background()); err != nil {
			t.Fatalf("the injected database was closed: %v", err)
		}
	})
}

// The bootstrap helpers mint a token through the store and validate it
// through the validator on both backends.
func TestMintAndValidateToken(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		ctx := context.Background()
		raw, err := MintToken(ctx, db, "bootstrap-test")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			_, _ = db.ExecContext(context.Background(), `DELETE FROM access_tokens WHERE name = 'bootstrap-test'`)
		})
		if !strings.HasPrefix(raw, "ftd_") {
			t.Fatalf("minted token %q lacks the ftd_ prefix", raw)
		}
		ok, err := TokenValid(ctx, db, raw)
		if err != nil || !ok {
			t.Fatalf("TokenValid(minted) = %v, %v", ok, err)
		}
		ok, err = TokenValid(ctx, db, "ftd_00000000000000000000000000000000")
		if err != nil || ok {
			t.Fatalf("TokenValid(unknown) = %v, %v", ok, err)
		}
	})
}
