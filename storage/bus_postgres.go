package storage

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// postgresListenCloseTimeout bounds closing a LISTEN connection once
// its subscription ends. The subscriber's context is usually already
// cancelled by then, so the close runs on a fresh short context; two
// seconds releases the server side promptly without letting an
// unreachable server hold up a shutdown.
const postgresListenCloseTimeout = 2 * time.Second

// PostgresBus is the Bus of Postgres mode: Publish is pg_notify through
// the pool, Subscribe is a dedicated LISTEN connection, so processes
// sharing the database see each other's notifications.
type PostgresBus struct {
	db      *sql.DB
	connURL string

	// closed and stop end the bus: Close sets one and closes the other
	// under mu, and waits on wg for every LISTEN connection to close.
	mu     sync.Mutex
	closed bool
	stop   chan struct{}
	wg     sync.WaitGroup
}

// NewPostgresBus returns a bus publishing through db and listening on
// connections dialled from connURL (the database URL db was opened
// with). A listener holds its connection for the life of the
// subscription, so it is dialled directly rather than borrowed from the
// pool that is sized for request traffic.
func NewPostgresBus(db *sql.DB, connURL string) *PostgresBus {
	return &PostgresBus{db: db, connURL: connURL, stop: make(chan struct{})}
}

func (b *PostgresBus) isClosed() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.closed
}

// Publish sends payload on channel with pg_notify. The channel name and
// payload are bound parameters, so neither can alter the statement.
func (b *PostgresBus) Publish(ctx context.Context, channel, payload string) error {
	if b.isClosed() {
		return ErrBusClosed
	}
	if _, err := b.db.ExecContext(ctx, "SELECT pg_notify($1, $2)", channel, payload); err != nil {
		return fmt.Errorf("storage: notify %s: %w", channel, err)
	}
	return nil
}

// Subscribe opens a connection, issues LISTEN and forwards every
// notification until ctx is done, the connection fails or the bus is
// closed; the returned channel is closed in each case. An error means
// no connection could be opened or LISTEN failed.
func (b *PostgresBus) Subscribe(ctx context.Context, channel string) (<-chan string, error) {
	if b.isClosed() {
		return nil, ErrBusClosed
	}
	conn, err := pgx.Connect(ctx, b.connURL)
	if err != nil {
		return nil, fmt.Errorf("storage: connect for LISTEN: %w", err)
	}
	if _, err := conn.Exec(ctx, "LISTEN "+pgx.Identifier{channel}.Sanitize()); err != nil {
		closeListenConn(conn)
		return nil, fmt.Errorf("storage: LISTEN %s: %w", channel, err)
	}

	// Counted under mu, so Close (which sets closed under mu before it
	// waits) never misses a connection that was dialled first.
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		closeListenConn(conn)
		return nil, ErrBusClosed
	}
	b.wg.Add(1)
	b.mu.Unlock()

	// The wait for a notification ends with the subscriber's context
	// or with the bus.
	subCtx, cancel := context.WithCancel(ctx)
	go func() {
		select {
		case <-b.stop:
			cancel()
		case <-subCtx.Done():
		}
	}()

	ch := make(chan string, busBuffer)
	go func() {
		defer b.wg.Done()
		defer close(ch)
		defer closeListenConn(conn)
		defer cancel()
		for {
			n, err := conn.WaitForNotification(subCtx)
			if err != nil {
				return
			}
			select {
			case ch <- n.Payload:
			case <-subCtx.Done():
				return
			}
		}
	}()
	return ch, nil
}

// Close ends every subscription and waits until each LISTEN connection
// has been closed (bounded by postgresListenCloseTimeout per
// connection).
func (b *PostgresBus) Close() error {
	b.mu.Lock()
	if !b.closed {
		b.closed = true
		close(b.stop)
	}
	b.mu.Unlock()
	b.wg.Wait()
	return nil
}

func closeListenConn(conn *pgx.Conn) {
	cctx, cancel := context.WithTimeout(context.Background(), postgresListenCloseTimeout)
	defer cancel()
	_ = conn.Close(cctx)
}
