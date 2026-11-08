package app

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// The lifecycle tests run against a migrated database (TEST_POSTGRES_URL,
// provided by scripts/go-db-tests.sh); the loops Run starts open
// LISTEN connections and run queries, which a dummy DSN cannot serve.

// runTimeout bounds how long a test waits for Run to return after the
// context is cancelled: ShutdownTimeout plus margin for the test box.
const runTimeout = 20 * time.Second

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("no TEST_POSTGRES_URL set; skipping DB test")
	}
	pool, err := NewPool(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

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

func TestRun_StopsOnCancelAndLeavesAnInjectedPoolOpen(t *testing.T) {
	pool := testPool(t)
	addr := freeAddr(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, err := New(ctx, Config{ListenAddr: addr, CORSOrigin: "*", ShutdownTimeout: 10 * time.Second}, Deps{Pool: pool})
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
	if err := pool.Ping(context.Background()); err != nil {
		t.Fatalf("the injected pool was closed by Run: %v", err)
	}
	if _, err := http.Get(fmt.Sprintf("http://%s/health", addr)); err == nil {
		t.Fatal("the listener is still serving after Run returned")
	}
}

func TestRun_ClosesThePoolItOpened(t *testing.T) {
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("no TEST_POSTGRES_URL set; skipping DB test")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	addr := freeAddr(t)
	a, err := New(ctx, Config{ListenAddr: addr, PostgresURL: dsn, CORSOrigin: "*", ShutdownTimeout: 10 * time.Second}, Deps{})
	if err != nil {
		t.Fatal(err)
	}
	owned := a.pool
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()
	waitHealthy(t, addr)
	cancel()
	if err := awaitRun(t, done); err != nil {
		t.Fatal(err)
	}
	if a.pool != nil || a.ownsPool {
		t.Fatal("Run must close and forget the pool it opened")
	}
	if err := owned.Ping(context.Background()); err == nil {
		t.Fatal("the pool Run opened still answers after Run returned")
	}
}

func TestRun_ListenerBindFailureIsReturned(t *testing.T) {
	pool := testPool(t)
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = busy.Close() }()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, err := New(ctx, Config{ListenAddr: busy.Addr().String(), CORSOrigin: "*", ShutdownTimeout: 10 * time.Second}, Deps{Pool: pool})
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()
	err = awaitRun(t, done)
	if err == nil || !strings.Contains(err.Error(), "query API server") {
		t.Fatalf("Run on a busy port returned %v, want the listener's error", err)
	}
	if err := pool.Ping(context.Background()); err != nil {
		t.Fatalf("the injected pool was closed: %v", err)
	}
}
