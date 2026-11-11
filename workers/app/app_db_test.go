package app

import (
	"context"
	"os"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/nats-io/nats-server/v2/server"
	"github.com/nats-io/nats.go"
)

// The lifecycle tests run against a migrated database (TEST_POSTGRES_URL,
// provided by scripts/go-db-tests.sh): the reconciler and the backfill
// query the schema. The bus is an embedded nats-server with no listener
// and no FLIGHTDECK stream, so the consumer waits for the stream until
// the context ends, as it does when the workers start before ingestion.

// runTimeout bounds how long a test waits for Run to return after the
// context is cancelled: ShutdownTimeout plus margin for the test box.
const runTimeout = 20 * time.Second

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_POSTGRES_URL")
	if dsn == "" {
		t.Skip("no TEST_POSTGRES_URL set; skipping DB test")
	}
	pool, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

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

func schemaVersion(t *testing.T, pool *pgxpool.Pool) int {
	t.Helper()
	var version int
	if err := pool.QueryRow(context.Background(), "SELECT version FROM schema_migrations").Scan(&version); err != nil {
		t.Fatal(err)
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

func TestRun_DoesNotMigrateAndLeavesInjectedConnectionsOpen(t *testing.T) {
	pool := testPool(t)
	nc := embeddedNATS(t)
	before := schemaVersion(t, pool)
	// A migration that cannot apply: Run must never read Deps.Migrations.
	bad := fstest.MapFS{
		"000999_bad.up.sql":   {Data: []byte("THIS IS NOT SQL;")},
		"000999_bad.down.sql": {Data: []byte("THIS IS NOT SQL;")},
	}
	// Run spawns its loops before it watches the context, so cancelling
	// at once still exercises the start, the join and the close; the
	// assertions below need none of the loops to have done any work.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	done := make(chan error, 1)
	go func() { done <- Run(ctx, testConfig(), Deps{Pool: pool, NATS: nc, Migrations: bad}) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned %v on a cancelled context, want nil", err)
		}
	case <-time.After(runTimeout):
		t.Fatalf("Run did not return within %s of the context ending", runTimeout)
	}
	if after := schemaVersion(t, pool); after != before {
		t.Fatalf("schema version went from %d to %d: Run migrated", before, after)
	}
	if err := pool.Ping(context.Background()); err != nil {
		t.Fatalf("the injected pool was closed by Run: %v", err)
	}
	if !nc.IsConnected() {
		t.Fatal("the injected NATS connection was closed by Run")
	}
}

func TestMigrate_AppliesTheBadFileAndFails(t *testing.T) {
	// The counterpart of the test above: Migrate does read
	// Deps.Migrations, so the same bad file is an error here (and leaves
	// the version untouched, since golang-migrate applies nothing).
	pool := testPool(t)
	before := schemaVersion(t, pool)
	bad := fstest.MapFS{
		"000999_bad.up.sql":   {Data: []byte("THIS IS NOT SQL;")},
		"000999_bad.down.sql": {Data: []byte("THIS IS NOT SQL;")},
	}
	err := Migrate(Config{PostgresURL: os.Getenv("TEST_POSTGRES_URL")}, Deps{Migrations: bad})
	if err == nil || !strings.Contains(err.Error(), "database migration") {
		t.Fatalf("err = %v", err)
	}
	// golang-migrate marks the failed version dirty; put the row back so
	// the package's other tests and the script's checks see a clean schema.
	if _, err := pool.Exec(context.Background(), "UPDATE schema_migrations SET version = $1, dirty = false", before); err != nil {
		t.Fatal(err)
	}
}
