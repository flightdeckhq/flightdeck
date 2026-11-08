package app

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The lifecycle tests run on every backend storagetest covers: SQLite
// always (a migrated file in the test's temp directory), Postgres when
// TEST_POSTGRES_URL names a database (scripts/go-db-tests.sh). The
// revocation listener runs on the storage bus of either; the pgx pool
// of the stores still outside the boundary is real on Postgres and the
// unavailable one on SQLite. The bus is an embedded server (app_test.go).

// runTimeout bounds how long a test waits for Run to return after the
// context is cancelled: ShutdownTimeout plus margin for the test box.
const runTimeout = 20 * time.Second

// poolFor opens a pgx pool on the Postgres database db is, or returns
// nil on SQLite so New points the pgx stores at the unavailable URL.
func poolFor(t *testing.T, db *storage.DB) *pgxpool.Pool {
	t.Helper()
	if db.Backend != storage.Postgres {
		return nil
	}
	pool, err := pgxpool.New(context.Background(), db.URL())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

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

func TestRun_StopsOnCancelAndLeavesInjectedConnectionsOpen(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		pool := poolFor(t, db)
		nc := embeddedNATS(t)
		cfg := testConfig()
		cfg.ListenAddr = freeAddr(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		a, err := New(ctx, cfg, Deps{DB: db, Pool: pool, NATS: nc})
		if err != nil {
			t.Fatal(err)
		}
		if a.ownsDB || a.ownsNATS || (pool != nil && a.ownsPool) {
			t.Fatalf("ownsDB=%v ownsPool=%v ownsNATS=%v: New owns only what it opened", a.ownsDB, a.ownsPool, a.ownsNATS)
		}
		done := make(chan error, 1)
		go func() { done <- a.Run(ctx) }()
		waitHealthy(t, cfg.ListenAddr)

		cancel()
		if err := awaitRun(t, done); err != nil {
			t.Fatalf("Run returned %v on a cancelled context, want nil", err)
		}
		if err := db.Reader().PingContext(context.Background()); err != nil {
			t.Fatalf("the injected storage DB was closed by Run: %v", err)
		}
		if pool != nil {
			if err := pool.Ping(context.Background()); err != nil {
				t.Fatalf("the injected pool was closed by Run: %v", err)
			}
		}
		if !nc.IsConnected() {
			t.Fatal("the injected NATS connection was closed by Run")
		}
		if _, err := http.Get(fmt.Sprintf("http://%s/health", cfg.ListenAddr)); err == nil {
			t.Fatal("the listener is still serving after Run returned")
		}
	})
}

func TestRun_ClosesTheDatabaseItOpened(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		nc := embeddedNATS(t)
		cfg := testConfig()
		cfg.PostgresURL = db.URL()
		cfg.ListenAddr = freeAddr(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		a, err := New(ctx, cfg, Deps{NATS: nc})
		if err != nil {
			t.Fatal(err)
		}
		if !a.ownsDB || !a.ownsPool {
			t.Fatalf("ownsDB=%v ownsPool=%v: New must own what it opened", a.ownsDB, a.ownsPool)
		}
		ownedDB, ownedPool := a.db, a.pool
		done := make(chan error, 1)
		go func() { done <- a.Run(ctx) }()
		waitHealthy(t, cfg.ListenAddr)
		cancel()
		if err := awaitRun(t, done); err != nil {
			t.Fatal(err)
		}
		if a.db != nil || a.pool != nil || a.ownsDB || a.ownsPool {
			t.Fatal("Run must close and forget the database and pool it opened")
		}
		if err := ownedDB.Reader().PingContext(context.Background()); err == nil {
			t.Fatal("the storage DB Run opened still answers after Run returned")
		}
		if db.Backend == storage.Postgres {
			if err := ownedPool.Ping(context.Background()); err == nil {
				t.Fatal("the pool Run opened still answers after Run returned")
			}
		}
		if !nc.IsConnected() {
			t.Fatal("the injected NATS connection was closed")
		}
	})
}

func TestRun_ListenerBindFailureIsReturned(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		pool := poolFor(t, db)
		nc := embeddedNATS(t)
		busy, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = busy.Close() }()
		cfg := testConfig()
		cfg.ListenAddr = busy.Addr().String()
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		a, err := New(ctx, cfg, Deps{DB: db, Pool: pool, NATS: nc})
		if err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- a.Run(ctx) }()
		err = awaitRun(t, done)
		if err == nil || !strings.Contains(err.Error(), "ingestion server") {
			t.Fatalf("Run on a busy port returned %v, want the listener's error", err)
		}
		if err := db.Reader().PingContext(context.Background()); err != nil || !nc.IsConnected() {
			t.Fatalf("injected connections were closed: ping=%v connected=%v", err, nc.IsConnected())
		}
	})
}
