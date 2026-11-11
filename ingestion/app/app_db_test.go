package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// The lifecycle tests run on every backend storagetest covers: SQLite
// always (a migrated file in the test's temp directory), Postgres when
// TEST_POSTGRES_URL names a database (scripts/go-db-tests.sh). Every
// store, the revocation listener and the GenAI assembler run on the
// storage database of either. The bus is an embedded server
// (app_test.go).

// runTimeout bounds how long a test waits for Run to return after the
// context is cancelled: ShutdownTimeout plus margin for the test box.
const runTimeout = 20 * time.Second

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
		nc := embeddedNATS(t)
		cfg := testConfig()
		cfg.ListenAddr = freeAddr(t)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		a, err := New(ctx, cfg, Deps{DB: db, NATS: nc})
		if err != nil {
			t.Fatal(err)
		}
		if a.ownsDB || a.ownsNATS {
			t.Fatalf("ownsDB=%v ownsNATS=%v: New owns only what it opened", a.ownsDB, a.ownsNATS)
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
		if !nc.IsConnected() {
			t.Fatal("the injected NATS connection was closed by Run")
		}
		if _, err := http.Get(fmt.Sprintf("http://%s/health", cfg.ListenAddr)); err == nil {
			t.Fatal("the listener is still serving after Run returned")
		}
	})
}

// The flightdeck binary passes the one bus its services share; the app
// subscribes on it and leaves it open. A bus the app created itself is
// closed when Run returns.
func TestRun_LeavesAnInjectedBusOpenAndClosesItsOwn(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		nc := embeddedNATS(t)
		run := func(deps Deps) *App {
			t.Helper()
			cfg := testConfig()
			cfg.ListenAddr = freeAddr(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			a, err := New(ctx, cfg, deps)
			if err != nil {
				t.Fatal(err)
			}
			done := make(chan error, 1)
			go func() { done <- a.Run(ctx) }()
			waitHealthy(t, cfg.ListenAddr)
			cancel()
			if err := awaitRun(t, done); err != nil {
				t.Fatal(err)
			}
			return a
		}

		injected := storage.NewBus(db)
		t.Cleanup(func() { _ = injected.Close() })
		a := run(Deps{DB: db, Bus: injected, NATS: nc})
		if a.ownsBus || a.bus != injected {
			t.Fatalf("ownsBus=%v: an injected bus is used as is and never owned", a.ownsBus)
		}
		if err := injected.Publish(context.Background(), "storagetest_after_run", "x"); err != nil {
			t.Fatalf("the injected bus was closed by Run: %v", err)
		}

		b, err := New(context.Background(), testConfig(), Deps{DB: db, NATS: nc})
		if err != nil {
			t.Fatal(err)
		}
		own := b.bus
		if !b.ownsBus || own == nil {
			t.Fatal("New must create and own a bus when none is injected")
		}
		b.closeOwned()
		if b.bus != nil || b.ownsBus {
			t.Fatal("closeOwned must close and forget the bus New created")
		}
		if err := own.Publish(context.Background(), "storagetest_after_run", "x"); !errors.Is(err, storage.ErrBusClosed) {
			t.Fatalf("publish on the bus New created: %v, want ErrBusClosed", err)
		}
		if err := db.Reader().PingContext(context.Background()); err != nil {
			t.Fatalf("closeOwned closed the injected database: %v", err)
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
		if !a.ownsDB {
			t.Fatal("New must own the database it opened")
		}
		ownedDB := a.db
		done := make(chan error, 1)
		go func() { done <- a.Run(ctx) }()
		waitHealthy(t, cfg.ListenAddr)
		cancel()
		if err := awaitRun(t, done); err != nil {
			t.Fatal(err)
		}
		if a.db != nil || a.ownsDB {
			t.Fatal("Run must close and forget the database it opened")
		}
		if err := ownedDB.Reader().PingContext(context.Background()); err == nil {
			t.Fatal("the storage DB Run opened still answers after Run returned")
		}
		if !nc.IsConnected() {
			t.Fatal("the injected NATS connection was closed")
		}
	})
}

func TestRun_ListenerBindFailureIsReturned(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
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
		a, err := New(ctx, cfg, Deps{DB: db, NATS: nc})
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
