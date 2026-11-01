package writer

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// LockTimeout is how long a statement on the worker's connections waits
// for a row lock before Postgres aborts it. It sits under the consumer's
// ten-second processing deadline: when the deadline cancels a message,
// pgx closes the connection without cancelling the statement on the
// server, so without this bound the backend would stay blocked on the
// lock, holding a connection, until the lock was released.
const LockTimeout = 8 * time.Second

// PoolConfig is the worker's connection pool configuration for url, with
// LockTimeout set on every connection.
func PoolConfig(url string) (*pgxpool.Config, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, fmt.Errorf("parse postgres url: %w", err)
	}
	cfg.ConnConfig.RuntimeParams["lock_timeout"] = strconv.FormatInt(LockTimeout.Milliseconds(), 10)
	return cfg, nil
}

// NewPool opens the worker's connection pool for url (see PoolConfig).
func NewPool(ctx context.Context, url string) (*pgxpool.Pool, error) {
	cfg, err := PoolConfig(url)
	if err != nil {
		return nil, err
	}
	return pgxpool.NewWithConfig(ctx, cfg)
}
