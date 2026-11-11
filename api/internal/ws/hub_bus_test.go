package ws

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/flightdeckhq/flightdeck/api/internal/store"
	"github.com/flightdeckhq/flightdeck/storage"
)

// busTestDeadline bounds how long a test waits for a notification to
// reach a client: a channel send and three indexed reads of a fake
// store, so a second is generous.
const busTestDeadline = 5 * time.Second

// startHub runs the hub and ListenNotify on bus and registers one
// client, returning the client's outbound queue. Everything stops with
// ctx.
func startHub(t *testing.T, ctx context.Context, h *Hub, bus storage.Bus) <-chan []byte {
	t.Helper()
	go h.Run(ctx)
	stopped := make(chan struct{})
	go func() {
		h.ListenNotify(ctx, bus)
		close(stopped)
	}()
	t.Cleanup(func() {
		select {
		case <-stopped:
		case <-time.After(busTestDeadline):
			t.Error("ListenNotify did not stop with its context")
		}
	})
	client := &Client{send: make(chan []byte, 8)}
	h.register <- client
	return client.send
}

// recordingBus counts subscriptions and can close the first working
// one after a payload, like a LISTEN connection that drops.
type recordingBus struct {
	*storage.InProcessBus
	subscriptions atomic.Int32
	gapFirst      bool
	gapped        atomic.Bool
}

func (b *recordingBus) Subscribe(ctx context.Context, channel string) (<-chan string, error) {
	inner, err := b.InProcessBus.Subscribe(ctx, channel)
	if err != nil {
		return nil, err
	}
	// Counted once the subscriber is registered, so a test that waits
	// on the count cannot publish into the gap before it.
	b.subscriptions.Add(1)
	if !b.gapFirst || !b.gapped.CompareAndSwap(false, true) {
		return inner, nil
	}
	out := make(chan string)
	go func() {
		defer close(out)
		select {
		case p, ok := <-inner:
			if ok {
				out <- p
			}
		case <-ctx.Done():
		}
	}()
	return out, nil
}

// waitSubscribed polls until the bus has seen n subscriptions.
func waitSubscribed(t *testing.T, bus *recordingBus, n int32) {
	t.Helper()
	deadline := time.Now().Add(notifyReconnectDelay + busTestDeadline)
	for bus.subscriptions.Load() < n {
		if time.Now().After(deadline) {
			t.Fatalf("bus saw %d subscriptions, want %d", bus.subscriptions.Load(), n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func receive(t *testing.T, ch <-chan []byte) map[string]any {
	t.Helper()
	select {
	case msg := <-ch:
		var decoded map[string]any
		if err := json.Unmarshal(msg, &decoded); err != nil {
			t.Fatalf("broadcast is not JSON: %s", msg)
		}
		return decoded
	case <-time.After(busTestDeadline):
		t.Fatal("no broadcast reached the client")
		return nil
	}
}

// A notification published on the fleet channel reaches every client
// as the hub's enriched message: the directive sentinel as a
// directives_changed message, a session payload as a session_update
// carrying the session the store returns.
func TestListenNotify_BroadcastsBusNotifications(t *testing.T) {
	fs := &fakeStore{
		sessions:    map[string]*store.Session{testSessionID: {SessionID: testSessionID, Flavor: "bus-test", State: "active"}},
		agentStates: map[string]string{},
	}
	h := NewHub(fs)
	bus := &recordingBus{InProcessBus: storage.NewInProcessBus()}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := startHub(t, ctx, h, bus)
	waitSubscribed(t, bus, 1)

	if err := bus.Publish(ctx, store.NotifyChannel, store.NotifyDirectiveRegistered); err != nil {
		t.Fatal(err)
	}
	if msg := receive(t, out); msg["type"] != msgTypeDirectivesChange {
		t.Fatalf("directive sentinel broadcast as %v", msg)
	}

	if err := bus.Publish(ctx, store.NotifyChannel, `{"session_id":"`+testSessionID+`","event_type":"session_update"}`); err != nil {
		t.Fatal(err)
	}
	msg := receive(t, out)
	if msg["type"] != msgTypeSessionUpdate {
		t.Fatalf("session payload broadcast as %v", msg)
	}
	sess, _ := msg["session"].(map[string]any)
	if sess["session_id"] != testSessionID || sess["flavor"] != "bus-test" {
		t.Fatalf("broadcast carries %v, want the stored session", msg["session"])
	}
	// A payload the hub cannot use is dropped, not broadcast.
	if err := bus.Publish(ctx, store.NotifyChannel, "not json"); err != nil {
		t.Fatal(err)
	}
	select {
	case msg := <-out:
		t.Fatalf("an unparseable payload was broadcast: %s", msg)
	case <-time.After(200 * time.Millisecond):
	}
}

// listenOnce reports a subscription that closed before the context
// ended as a gap, and ListenNotify then subscribes again after the
// reconnect delay, so a dropped LISTEN connection on Postgres is
// recovered without losing later notifications.
func TestListenNotify_ResubscribesAfterTheSubscriptionCloses(t *testing.T) {
	fs := &fakeStore{sessions: map[string]*store.Session{}, agentStates: map[string]string{}}
	h := NewHub(fs)
	bus := &recordingBus{InProcessBus: storage.NewInProcessBus(), gapFirst: true}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	out := startHub(t, ctx, h, bus)
	waitSubscribed(t, bus, 1)

	// The first payload is delivered and then closes the gappy
	// subscription.
	if err := bus.Publish(ctx, store.NotifyChannel, store.NotifyDirectiveRegistered); err != nil {
		t.Fatal(err)
	}
	receive(t, out)
	waitSubscribed(t, bus, 2)

	// The new subscription delivers.
	if err := bus.Publish(ctx, store.NotifyChannel, store.NotifyDirectiveRegistered); err != nil {
		t.Fatal(err)
	}
	if msg := receive(t, out); msg["type"] != msgTypeDirectivesChange {
		t.Fatalf("after the resubscription the broadcast was %v", msg)
	}
}

// listenOnce's return value tells a closed subscription from a
// cancelled context.
func TestListenOnce_ClosedChannelIsAGap(t *testing.T) {
	h := NewHub(&fakeStore{})
	bus := &recordingBus{InProcessBus: storage.NewInProcessBus(), gapFirst: true}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- h.listenOnce(ctx, bus) }()
	waitSubscribed(t, bus, 1)
	if err := bus.Publish(ctx, store.NotifyChannel, "ignored"); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != errSubscriptionClosed {
			t.Fatalf("listenOnce returned %v, want errSubscriptionClosed", err)
		}
	case <-time.After(busTestDeadline):
		t.Fatal("listenOnce did not return after its channel closed")
	}

	// A cancelled context ends the subscription and is reported as such.
	ctx2, cancel2 := context.WithCancel(context.Background())
	go func() { done <- h.listenOnce(ctx2, bus) }()
	waitSubscribed(t, bus, 2)
	cancel2()
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Fatalf("listenOnce returned %v on a cancelled context, want context.Canceled", err)
		}
	case <-time.After(busTestDeadline):
		t.Fatal("listenOnce did not return after its context was cancelled")
	}
}
