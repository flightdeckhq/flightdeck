package storage

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// shortLockWait stands in for migrationLockWait, so a test of the bound
// takes a second, not ten minutes.
const shortLockWait = time.Second

// lockTestTimeout bounds a test whose wait must end by itself.
const lockTestTimeout = 30 * time.Second

func TestWaitForMigrationLock_GivesUpAfterItsBound(t *testing.T) {
	var asks atomic.Int32
	began := time.Now()
	err := waitForMigrationLock(context.Background(), func() (bool, error) {
		asks.Add(1)
		return false, nil
	}, "the test database", shortLockWait)
	if err == nil {
		t.Fatal("the wait ended without the lock and without an error")
	}
	if !strings.Contains(err.Error(), "the test database for more than 1s") {
		t.Fatalf("err = %v, want it to name the database and the wait", err)
	}
	if took := time.Since(began); took < shortLockWait || took > lockTestTimeout {
		t.Fatalf("the wait took %s, want about %s", took, shortLockWait)
	}
	// It asked again and again, each ask a short one.
	if n := asks.Load(); n < 2 {
		t.Fatalf("the lock was asked for %d times in %s", n, shortLockWait)
	}
}

func TestWaitForMigrationLock_EndsWithItsContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var asks atomic.Int32
	done := make(chan error, 1)
	go func() {
		done <- waitForMigrationLock(ctx, func() (bool, error) {
			if asks.Add(1) == 2 {
				cancel()
			}
			return false, nil
		}, "db", migrationLockWait)
	}()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v, want the context's cancellation", err)
		}
	case <-time.After(lockTestTimeout):
		t.Fatal("the wait did not end with its context")
	}
}

func TestWaitForMigrationLock_TakesAFreeLockAtOnceAndReportsAFailedAsk(t *testing.T) {
	if err := waitForMigrationLock(context.Background(), func() (bool, error) { return true, nil }, "db", shortLockWait); err != nil {
		t.Fatal(err)
	}
	refused := errors.New("connection refused")
	err := waitForMigrationLock(context.Background(), func() (bool, error) { return false, refused }, "db", shortLockWait)
	if !errors.Is(err, refused) {
		t.Fatalf("err = %v, want the ask's own error", err)
	}
}
