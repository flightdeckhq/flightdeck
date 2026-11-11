package storage_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"testing/synctest"
	"time"

	"github.com/flightdeckhq/flightdeck/storage"
	"github.com/flightdeckhq/flightdeck/storage/storagetest"
)

// busDeadline bounds a wait for one notification. Delivery is a channel
// send in-process or one NOTIFY round trip on Postgres (milliseconds);
// five seconds leaves room for a loaded CI host.
const busDeadline = 5 * time.Second

func receive(t *testing.T, ch <-chan string) string {
	t.Helper()
	select {
	case p, ok := <-ch:
		if !ok {
			t.Fatal("subscription closed before a payload arrived")
		}
		return p
	case <-time.After(busDeadline):
		t.Fatal("no payload within the deadline")
		return ""
	}
}

func expectClosed(t *testing.T, ch <-chan string) {
	t.Helper()
	deadline := time.After(busDeadline)
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		case <-deadline:
			t.Fatal("subscription not closed within the deadline")
		}
	}
}

func TestNewBus_MatchesBackend(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		bus := storage.NewBus(db)
		switch db.Backend {
		case storage.SQLite:
			if _, ok := bus.(*storage.InProcessBus); !ok {
				t.Fatalf("SQLite bus is %T, want *InProcessBus", bus)
			}
		case storage.Postgres:
			if _, ok := bus.(*storage.PostgresBus); !ok {
				t.Fatalf("Postgres bus is %T, want *PostgresBus", bus)
			}
		}
	})
}

// The contract every subscriber relies on, on both implementations.
func TestBus_PublishReachesEverySubscriber(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		bus := storage.NewBus(db)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		const channel = "storagetest_bus"

		// No subscriber: publishing is fine and nothing is kept.
		if err := bus.Publish(ctx, channel, "lost"); err != nil {
			t.Fatal(err)
		}

		a, err := bus.Subscribe(ctx, channel)
		if err != nil {
			t.Fatal(err)
		}
		b, err := bus.Subscribe(ctx, channel)
		if err != nil {
			t.Fatal(err)
		}
		other, err := bus.Subscribe(ctx, channel+"_other")
		if err != nil {
			t.Fatal(err)
		}

		payload := `{"session_id":"s1","event_type":"post_call","event_id":"e1"}`
		if err := bus.Publish(ctx, channel, payload); err != nil {
			t.Fatal(err)
		}
		if got := receive(t, a); got != payload {
			t.Errorf("a got %q", got)
		}
		if got := receive(t, b); got != payload {
			t.Errorf("b got %q", got)
		}
		select {
		case p := <-other:
			t.Errorf("other channel received %q", p)
		case <-time.After(100 * time.Millisecond):
		}

		// Order is kept per subscriber.
		for _, p := range []string{"1", "2", "3"} {
			if err := bus.Publish(ctx, channel, p); err != nil {
				t.Fatal(err)
			}
		}
		for _, want := range []string{"1", "2", "3"} {
			if got := receive(t, a); got != want {
				t.Errorf("a got %q, want %q", got, want)
			}
		}

		// Cancelling closes the subscriptions.
		cancel()
		expectClosed(t, a)
		expectClosed(t, b)
		expectClosed(t, other)
	})
}

// Close ends the subscriptions that are still open, refuses new work
// and can be called twice; on both implementations.
func TestBus_CloseEndsSubscriptionsAndRefusesNewWork(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		bus := storage.NewBus(db)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		const channel = "storagetest_bus_close"

		open, err := bus.Subscribe(ctx, channel)
		if err != nil {
			t.Fatal(err)
		}
		// A subscription whose context already ended is unwound by the
		// time Close returns, too.
		endedCtx, endSub := context.WithCancel(ctx)
		ended, err := bus.Subscribe(endedCtx, channel)
		if err != nil {
			t.Fatal(err)
		}
		endSub()

		if err := bus.Publish(ctx, channel, "before"); err != nil {
			t.Fatal(err)
		}
		if got := receive(t, open); got != "before" {
			t.Errorf("got %q", got)
		}

		closed := make(chan error, 1)
		go func() { closed <- bus.Close() }()
		select {
		case err := <-closed:
			if err != nil {
				t.Fatalf("Close: %v", err)
			}
		case <-time.After(busDeadline):
			t.Fatal("Close did not return")
		}
		// Close has returned, so both channels are closed already: no
		// goroutine of the bus is left to close them later.
		for name, ch := range map[string]<-chan string{"open": open, "ended": ended} {
			select {
			case _, ok := <-ch:
				if ok {
					// A payload buffered before the close may still
					// be read; the close follows it.
					expectClosed(t, ch)
				}
			default:
				t.Errorf("%s subscription still open after Close returned", name)
			}
		}

		if err := bus.Publish(ctx, channel, "after"); !errors.Is(err, storage.ErrBusClosed) {
			t.Errorf("Publish after Close: %v, want ErrBusClosed", err)
		}
		if _, err := bus.Subscribe(ctx, channel); !errors.Is(err, storage.ErrBusClosed) {
			t.Errorf("Subscribe after Close: %v, want ErrBusClosed", err)
		}
		if err := bus.Close(); err != nil {
			t.Errorf("second Close: %v", err)
		}
	})
}

// Close releases a publisher that is waiting on a subscriber's full
// buffer; the publisher is not left blocked on a bus nobody reads. The
// test runs in a synctest bubble so "the publisher is waiting" is a
// fact (every goroutine blocked) rather than a guess about timing.
func TestInProcessBus_CloseReleasesABlockedPublisher(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		bus := storage.NewInProcessBus()
		ch, err := bus.Subscribe(context.Background(), "c")
		if err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 256; i++ {
			if err := bus.Publish(context.Background(), "c", "x"); err != nil {
				t.Fatal(err)
			}
		}
		blocked := make(chan error, 1)
		go func() { blocked <- bus.Publish(context.Background(), "c", "overflow") }()
		synctest.Wait()
		select {
		case err := <-blocked:
			t.Fatalf("publisher returned %v with the subscriber's buffer full", err)
		default:
		}

		if err := bus.Close(); err != nil {
			t.Fatal(err)
		}
		synctest.Wait()
		select {
		case err := <-blocked:
			if err != nil {
				t.Fatalf("publisher released by Close returned %v", err)
			}
		default:
			t.Fatal("publisher still blocked after Close")
		}
		expectClosed(t, ch)
	})
}

func TestBus_SubscriberCancelDoesNotAffectOthers(t *testing.T) {
	storagetest.Each(t, func(t *testing.T, db *storage.DB) {
		bus := storage.NewBus(db)
		ctx := context.Background()
		const channel = "storagetest_bus_cancel"

		shortCtx, cancelShort := context.WithCancel(ctx)
		short, err := bus.Subscribe(shortCtx, channel)
		if err != nil {
			t.Fatal(err)
		}
		longCtx, cancelLong := context.WithCancel(ctx)
		defer cancelLong()
		long, err := bus.Subscribe(longCtx, channel)
		if err != nil {
			t.Fatal(err)
		}

		cancelShort()
		expectClosed(t, short)

		if err := bus.Publish(ctx, channel, "after"); err != nil {
			t.Fatal(err)
		}
		if got := receive(t, long); got != "after" {
			t.Errorf("long got %q", got)
		}
	})
}

func TestInProcessBus_PublishWaitsForAFullSubscriberUntilItsContextEnds(t *testing.T) {
	bus := storage.NewInProcessBus()
	subCtx, cancelSub := context.WithCancel(context.Background())
	ch, err := bus.Subscribe(subCtx, "c")
	if err != nil {
		t.Fatal(err)
	}
	// Fill the buffer without reading.
	for i := 0; i < 256; i++ {
		if err := bus.Publish(context.Background(), "c", "x"); err != nil {
			t.Fatal(err)
		}
	}
	// The next publish blocks until the publisher's context ends...
	pubCtx, cancelPub := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancelPub()
	if err := bus.Publish(pubCtx, "c", "overflow"); err != context.DeadlineExceeded {
		t.Fatalf("publish to a full subscriber: %v, want DeadlineExceeded", err)
	}
	// ...or the subscriber's does.
	done := make(chan error, 1)
	go func() { done <- bus.Publish(context.Background(), "c", "overflow") }()
	cancelSub()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("publish after the subscriber left: %v", err)
		}
	case <-time.After(busDeadline):
		t.Fatal("publish did not return after the subscriber's context ended")
	}
	expectClosed(t, ch)
}

// A publisher blocked on one full subscriber holds nothing a second
// publisher needs: the second returns on its own deadline while the
// first is still waiting, and the first returns once the subscriber
// goes away.
func TestInProcessBus_BlockedPublisherDoesNotStallOtherPublishers(t *testing.T) {
	bus := storage.NewInProcessBus()
	subCtx, cancelSub := context.WithCancel(context.Background())
	ch, err := bus.Subscribe(subCtx, "c")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 256; i++ {
		if err := bus.Publish(context.Background(), "c", "x"); err != nil {
			t.Fatal(err)
		}
	}
	first := make(chan error, 1)
	go func() { first <- bus.Publish(context.Background(), "c", "blocked") }()
	// Let the first publisher reach its send.
	time.Sleep(50 * time.Millisecond)

	secondCtx, cancelSecond := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancelSecond()
	start := time.Now()
	if err := bus.Publish(secondCtx, "c", "second"); err != context.DeadlineExceeded {
		t.Fatalf("second publisher: %v, want DeadlineExceeded", err)
	}
	if took := time.Since(start); took > time.Second {
		t.Errorf("second publisher took %s to honour a 200 ms deadline", took)
	}
	select {
	case err := <-first:
		t.Fatalf("first publisher returned %v while the subscriber was still full", err)
	default:
	}

	// Other subscribers of the same channel are not held up either: a
	// publish that includes the full one still reaches them (the full
	// subscriber is delivered to first only because the map order is
	// arbitrary, so this publisher gets a deadline too).
	otherCtx, cancelOther := context.WithCancel(context.Background())
	defer cancelOther()
	other, err := bus.Subscribe(otherCtx, "c")
	if err != nil {
		t.Fatal(err)
	}
	thirdCtx, cancelThird := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancelThird()
	_ = bus.Publish(thirdCtx, "c", "third")

	cancelSub()
	select {
	case err := <-first:
		if err != nil {
			t.Fatalf("first publisher after the subscriber left: %v", err)
		}
	case <-time.After(busDeadline):
		t.Fatal("first publisher did not return after the subscriber's context ended")
	}
	expectClosed(t, ch)
	// Delivery to the live subscriber works after all that.
	if err := bus.Publish(context.Background(), "c", "after"); err != nil {
		t.Fatal(err)
	}
	for {
		got := receive(t, other)
		if got == "after" {
			break
		}
		if got != "third" {
			t.Fatalf("other received %q", got)
		}
	}
}

// The Postgres bus speaks the channels and payloads the services use
// today, so a notification from a database trigger reaches a subscriber
// unchanged.
func TestPostgresBus_ReceivesTriggerNotification(t *testing.T) {
	db := storagetest.OpenPostgres(t)
	bus := storage.NewBus(db)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch, err := bus.Subscribe(ctx, storage.ChannelAccessTokenRevoked)
	if err != nil {
		t.Fatal(err)
	}
	var id string
	if err := db.QueryRowContext(ctx,
		`INSERT INTO access_tokens (name, token_hash, salt, prefix) VALUES ('storagetest_bus', $1, 's', 'ftd_stor') RETURNING CAST(id AS TEXT)`,
		fmt.Sprintf("h-%d", time.Now().UnixNano())).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, "DELETE FROM access_tokens WHERE id = $1", id); err != nil {
		t.Fatal(err)
	}
	if got := receive(t, ch); got != id {
		t.Errorf("trigger payload %q, want the deleted id %q", got, id)
	}
}
