package store

import (
	"context"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// busTestDeadline bounds how long a test waits for a store's
// notification to arrive on the bus: a channel send in-process.
const busTestDeadline = 5 * time.Second

// RegisterDirectives publishes the directive_registered sentinel on the
// fleet channel after its commit, so the dashboard hub refreshes the
// Directives page; the rows are committed before the publish.
func TestRegisterDirectives_PublishesTheSentinelAfterCommit(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		bus := storage.NewInProcessBus()
		s := New(db, bus)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		ch, err := bus.Subscribe(ctx, NotifyChannel)
		if err != nil {
			t.Fatal(err)
		}
		flavor := "bus-test-" + randomUUID(t)[:8]
		t.Cleanup(func() {
			_, _ = db.ExecContext(context.Background(), `DELETE FROM custom_directives WHERE flavor = $1`, flavor)
		})
		if err := s.RegisterDirectives(ctx, []CustomDirective{{
			Fingerprint: "fp-bus-1", Name: "bus_pause", Description: "d", Flavor: flavor,
			Parameters: map[string]any{"seconds": map[string]any{"type": "integer"}},
		}}); err != nil {
			t.Fatalf("RegisterDirectives: %v", err)
		}
		select {
		case payload := <-ch:
			if payload != NotifyDirectiveRegistered {
				t.Fatalf("published %q, want %q", payload, NotifyDirectiveRegistered)
			}
		case <-time.After(busTestDeadline):
			t.Fatal("RegisterDirectives published nothing on the fleet channel")
		}
		// The row was committed before the notification went out.
		exists, err := s.CustomDirectiveExists(ctx, "fp-bus-1", flavor)
		if err != nil || !exists {
			t.Fatalf("registered directive not found after the notification: exists=%v err=%v", exists, err)
		}
	})
}

// DeleteAccessToken publishes the deleted token's id on the revocation
// channel after its commit (the auth package proves the validator drops
// the token on it).
func TestDeleteAccessToken_PublishesTheIDAfterCommit(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		bus := storage.NewInProcessBus()
		s := New(db, bus)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		ch, err := bus.Subscribe(ctx, AccessTokenRevokedChannel)
		if err != nil {
			t.Fatal(err)
		}
		created, err := s.CreateAccessToken(ctx, "bus-test-"+randomUUID(t)[:8])
		if err != nil {
			t.Fatal(err)
		}
		if err := s.DeleteAccessToken(ctx, created.ID); err != nil {
			t.Fatalf("DeleteAccessToken: %v", err)
		}
		select {
		case payload := <-ch:
			if payload != created.ID {
				t.Fatalf("published %q, want the deleted id %q", payload, created.ID)
			}
		case <-time.After(busTestDeadline):
			t.Fatal("DeleteAccessToken published nothing on the revocation channel")
		}
		if _, err := s.RenameAccessToken(ctx, created.ID, "gone"); err != ErrAccessTokenNotFound {
			t.Fatalf("token still present after the delete: %v", err)
		}
	})
}
