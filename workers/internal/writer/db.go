package writer

import (
	"fmt"
	"net/url"
	"strconv"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
)

// LockTimeout is how long a statement on the worker's Postgres
// connections waits for a row lock before Postgres aborts it. It sits
// under the consumer's ten-second processing deadline: when the deadline
// cancels a message, the driver closes the connection without cancelling
// the statement on the server, so without this bound the backend would
// stay blocked on the lock, holding a connection, until the lock was
// released. SQLite has no row locks: its one writer connection queues
// writes in Go and its busy timeout covers an out-of-process writer.
const LockTimeout = 8 * time.Second

// DatabaseURL returns the URL the worker opens its database with: a
// Postgres URL gains lock_timeout as a connection runtime parameter
// (pgx passes a URL query key it does not know to the server as a
// runtime parameter, so every connection of the pool carries it); a
// SQLite URL is returned unchanged. A lock_timeout the operator put in
// the URL is kept.
func DatabaseURL(rawURL string) (string, error) {
	backend, err := storage.BackendOf(rawURL)
	if err != nil {
		return "", err
	}
	if backend != storage.Postgres {
		return rawURL, nil
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", fmt.Errorf("parse postgres url: %w", err)
	}
	q := u.Query()
	if q.Get("lock_timeout") == "" {
		q.Set("lock_timeout", strconv.FormatInt(LockTimeout.Milliseconds(), 10))
	}
	u.RawQuery = q.Encode()
	return u.String(), nil
}
