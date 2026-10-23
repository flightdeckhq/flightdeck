package auth

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// AccessTokenRevokedChannel carries the id of every deleted access_tokens
// row (migration 000028's trigger). The literal matches
// api/internal/store.AccessTokenRevokedChannel; the services are separate
// Go modules.
const AccessTokenRevokedChannel = "flightdeck_access_token_revoked"

// revocationReconnectDelay is how long the revocation listener waits
// before reconnecting after its LISTEN connection fails. Every reconnect
// clears the whole validation cache, so the delay only bounds how long a
// revoked token can still ride the cacheTTL fallback while Postgres is
// unreachable; two seconds matches the fleet stream's reconnect cadence
// without hammering a database that is restarting.
const revocationReconnectDelay = 2 * time.Second

// closeTimeout bounds closing the listener's connection at shutdown, so
// an unreachable server cannot hold up the process exit.
const closeTimeout = 2 * time.Second

// Invalidate drops every cached validation that resolved to the token
// with the given id. Called when that token's access_tokens row is
// deleted, so the next request with it is re-checked against the
// database and rejected.
func (v *Validator) Invalidate(tokenID string) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.generation++
	for key, entry := range v.cache {
		if entry.result.ID == tokenID {
			delete(v.cache, key)
		}
	}
}

// Flush drops every cached validation.
func (v *Validator) Flush() {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.generation++
	v.cache = make(map[string]cacheEntry)
}

// ListenRevocations keeps a LISTEN connection on the revoked-token
// channel and invalidates cached validations as token rows are deleted.
// It returns when ctx is cancelled. A NOTIFY fired while no connection
// is listening is lost, so the cache is flushed each time the listener
// (re)connects; a revocation during an outage cannot outlive it.
func (v *Validator) ListenRevocations(ctx context.Context, pool *pgxpool.Pool) {
	for ctx.Err() == nil {
		err := v.listenRevocationsOnce(ctx, pool)
		if ctx.Err() != nil {
			return
		}
		slog.Error("token revocation listener error, reconnecting",
			"delay", revocationReconnectDelay, "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(revocationReconnectDelay):
		}
	}
}

func (v *Validator) listenRevocationsOnce(ctx context.Context, pool *pgxpool.Pool) error {
	// A dedicated connection, not one borrowed from the pool: the
	// listener holds it for the life of the process, and the pool is
	// sized for request traffic.
	conn, err := pgx.ConnectConfig(ctx, pool.Config().ConnConfig.Copy())
	if err != nil {
		return fmt.Errorf("connect for LISTEN: %w", err)
	}
	channel := pgx.Identifier{AccessTokenRevokedChannel}.Sanitize()
	defer func() {
		// The caller's ctx is usually cancelled by now; close on a fresh
		// short context so the server side is released promptly.
		cctx, cancel := context.WithTimeout(context.Background(), closeTimeout)
		defer cancel()
		_ = conn.Close(cctx)
	}()

	if _, err := conn.Exec(ctx, "LISTEN "+channel); err != nil {
		return fmt.Errorf("LISTEN failed: %w", err)
	}
	v.Flush()
	if v.onListening != nil {
		v.onListening()
	}
	slog.Info("listening for token revocations", "channel", AccessTokenRevokedChannel)

	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return fmt.Errorf("wait for notification: %w", err)
		}
		v.Invalidate(n.Payload)
	}
}
