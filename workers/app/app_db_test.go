package app

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// The lifecycle tests run against a migrated database on every covered
// backend (storagetest): the reconciler and the backfill query the
// schema. The bus is an embedded nats-server with no listener and no
// FLIGHTDECK stream, so the consumer waits for the stream until the
// context ends, as it does when the workers start before ingestion.

// runTimeout bounds how long a test waits for Run to return after the
// context is cancelled: ShutdownTimeout plus margin for the test box.
const runTimeout = 20 * time.Second

func embeddedNATS(t *testing.T) *nats.Conn {
	t.Helper()
	ns, err := server.NewServer(&server.Options{
		DontListen: true, JetStream: true, StoreDir: t.TempDir(), NoSigs: true,
		JetStreamMaxMemory: 64 << 20, JetStreamMaxStore: 256 << 20,
	})
	if err != nil {
		t.Fatal(err)
	}
	go ns.Start()
	if !ns.ReadyForConnections(10 * time.Second) {
		t.Fatal("embedded NATS did not start")
	}
	t.Cleanup(ns.Shutdown)
	nc, err := nats.Connect("", nats.InProcessServer(ns))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(nc.Close)
	return nc
}

func schemaVersion(t *testing.T, url string) uint {
	t.Helper()
	version, dirty, err := storage.SchemaVersion(context.Background(), url)
	if err != nil || dirty {
		t.Fatalf("schema version: %d dirty=%v err=%v", version, dirty, err)
	}
	return version
}

func testConfig() Config {
	return Config{
		WorkerPoolSize:     2,
		ReconcilerInterval: time.Second,
		OrphanTimeout:      24 * time.Hour,
		ShutdownTimeout:    10 * time.Second,
	}
}

// startGrace is how long runUntilCancelled lets Run start before the
// context ends. Run must open the configured database (when none is
// injected) and spawn its loops under a live context, so the context
// cannot be cancelled in advance; the loops themselves only wait for
// the stream, so the grace need only cover the open and the spawn,
// which take milliseconds, and the join and the close run after it.
const startGrace = 2 * time.Second

// runUntilCancelled runs Run on a context that ends after startGrace
// and checks Run returns cleanly within the shutdown timeout.
func runUntilCancelled(t *testing.T, cfg Config, deps Deps) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), startGrace)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- Run(ctx, cfg, deps) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned %v on a cancelled context, want nil", err)
		}
	case <-time.After(startGrace + runTimeout):
		t.Fatalf("Run did not return within %s of the context ending", runTimeout)
	}
}

func TestRun_DoesNotMigrateAndLeavesInjectedConnectionsOpen(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		nc := embeddedNATS(t)
		before := schemaVersion(t, db.URL())
		bus := storage.NewBus(db)
		t.Cleanup(func() { _ = bus.Close() })
		runUntilCancelled(t, testConfig(), Deps{DB: db, Bus: bus, NATS: nc})
		if after := schemaVersion(t, db.URL()); after != before {
			t.Fatalf("schema version went from %d to %d: Run migrated", before, after)
		}
		if err := bus.Publish(context.Background(), "storagetest_after_run", "x"); err != nil {
			t.Fatalf("the injected bus was closed by Run: %v", err)
		}
		if err := db.PingContext(context.Background()); err != nil {
			t.Fatalf("the injected database was closed by Run: %v", err)
		}
		if !nc.IsConnected() {
			t.Fatal("the injected NATS connection was closed by Run")
		}
	})
}

// With no database injected, Run opens the configured URL itself (the
// standalone binary's path) on either backend and closes it again.
func TestRun_OpensTheConfiguredDatabaseWhenNoneIsInjected(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		cfg := testConfig()
		cfg.PostgresURL = db.URL()
		runUntilCancelled(t, cfg, Deps{NATS: embeddedNATS(t)})
	})
}

// Migrate on a fresh SQLite file creates the schema; on a migrated
// database it is a no-op that leaves the version where it is.
func TestMigrate_AppliesTheEmbeddedSetOfTheURLsBackend(t *testing.T) {
	url := "sqlite://" + filepath.Join(t.TempDir(), "fresh.db")
	if v := schemaVersion(t, url); v != 0 {
		t.Fatalf("a new file reports version %d, want 0", v)
	}
	if err := Migrate(Config{PostgresURL: url}, Deps{}); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if v := schemaVersion(t, url); v == 0 {
		t.Fatal("no migration applied")
	}
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		before := schemaVersion(t, db.URL())
		if err := Migrate(Config{PostgresURL: db.URL()}, Deps{}); err != nil {
			t.Fatalf("migrate a current database: %v", err)
		}
		if after := schemaVersion(t, db.URL()); after != before {
			t.Fatalf("version moved from %d to %d on a current database", before, after)
		}
	})
}
