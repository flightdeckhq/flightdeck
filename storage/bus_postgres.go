package storage

import (
	"context"
	"database/sql"
	"fmt"
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
}

// NewPostgresBus returns a bus publishing through db and listening on
// connections dialled from connURL (the database URL db was opened
// with). A listener holds its connection for the life of the
// subscription, so it is dialled directly rather than borrowed from the
// pool that is sized for request traffic.
func NewPostgresBus(db *sql.DB, connURL string) *PostgresBus {
	return &PostgresBus{db: db, connURL: connURL}
}

// Publish sends payload on channel with pg_notify. The channel name and
// payload are bound parameters, so neither can alter the statement.
func (b *PostgresBus) Publish(ctx context.Context, channel, payload string) error {
	if _, err := b.db.ExecContext(ctx, "SELECT pg_notify($1, $2)", channel, payload); err != nil {
		return fmt.Errorf("storage: notify %s: %w", channel, err)
	}
	return nil
}

// Subscribe opens a connection, issues LISTEN and forwards every
// notification until ctx is done or the connection fails; the returned
// channel is closed in both cases. An error means no connection could
// be opened or LISTEN failed.
func (b *PostgresBus) Subscribe(ctx context.Context, channel string) (<-chan string, error) {
	conn, err := pgx.Connect(ctx, b.connURL)
	if err != nil {
		return nil, fmt.Errorf("storage: connect for LISTEN: %w", err)
	}
	if _, err := conn.Exec(ctx, "LISTEN "+pgx.Identifier{channel}.Sanitize()); err != nil {
		closeListenConn(conn)
		return nil, fmt.Errorf("storage: LISTEN %s: %w", channel, err)
	}

	ch := make(chan string, busBuffer)
	go func() {
		defer close(ch)
		defer closeListenConn(conn)
		for {
			n, err := conn.WaitForNotification(ctx)
			if err != nil {
				return
			}
			select {
			case ch <- n.Payload:
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch, nil
}

func closeListenConn(conn *pgx.Conn) {
	cctx, cancel := context.WithTimeout(context.Background(), postgresListenCloseTimeout)
	defer cancel()
	_ = conn.Close(cctx)
}
