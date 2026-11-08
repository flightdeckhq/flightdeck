package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"github.com/flightdeckhq/flightdeck/storage"
)

// revocationReconnectDelay is how long the revocation listener waits
// before subscribing again after its subscription fails or closes.
// Every resubscription clears the whole validation cache, so the delay
// only bounds how long a revoked token can still ride the cacheTTL
// fallback while the bus is unreachable; two seconds matches the fleet
// stream's reconnect cadence without hammering a database that is
// restarting.
const revocationReconnectDelay = 2 * time.Second

// errSubscriptionClosed is the listener's reason for resubscribing when
// the bus closed its channel before the context ended (on Postgres, the
// LISTEN connection dropped).
var errSubscriptionClosed = errors.New("revocation subscription closed")

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

// ListenRevocations keeps a subscription on the revoked-token channel
// of bus and invalidates cached validations as token ids arrive. It
// returns when ctx is cancelled. A notification published while no
// subscription is live is lost, so the cache is flushed each time the
// listener (re)subscribes; a revocation during a gap cannot outlive it.
func (v *Validator) ListenRevocations(ctx context.Context, bus storage.Bus) {
	for ctx.Err() == nil {
		err := v.listenRevocationsOnce(ctx, bus)
		if ctx.Err() != nil {
			return
		}
		slog.Error("token revocation listener error, resubscribing",
			"delay", revocationReconnectDelay, "err", err)
		select {
		case <-ctx.Done():
			return
		case <-time.After(revocationReconnectDelay):
		}
	}
}

func (v *Validator) listenRevocationsOnce(ctx context.Context, bus storage.Bus) error {
	ch, err := bus.Subscribe(ctx, store.AccessTokenRevokedChannel)
	if err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}
	v.Flush()
	if v.onListening != nil {
		v.onListening()
	}
	slog.Info("listening for token revocations", "channel", store.AccessTokenRevokedChannel)

	for payload := range ch {
		v.Invalidate(payload)
	}
	return errSubscriptionClosed
}
