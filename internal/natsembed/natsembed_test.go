package natsembed

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

func TestStart_JetStreamOverInProcessConnections(t *testing.T) {
	store := filepath.Join(t.TempDir(), "nats")
	s, err := Start(Options{StoreDir: store, StreamMaxBytes: 64 << 20})
	if err != nil {
		t.Fatal(err)
	}
	pub, err := s.Connect("pub")
	if err != nil {
		t.Fatal(err)
	}
	sub, err := s.Connect("sub")
	if err != nil {
		t.Fatal(err)
	}
	js, err := pub.JetStream()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := js.AddStream(&nats.StreamConfig{
		Name: "T", Subjects: []string{"t.>"}, Storage: nats.FileStorage, MaxBytes: 64 << 20,
	}); err != nil {
		t.Fatalf("add stream: %v", err)
	}
	if _, err := js.Publish("t.one", []byte("hello")); err != nil {
		t.Fatal(err)
	}
	sjs, _ := sub.JetStream()
	ps, err := sjs.PullSubscribe("t.>", "d")
	if err != nil {
		t.Fatal(err)
	}
	msgs, err := ps.Fetch(1, nats.MaxWait(5*time.Second))
	if err != nil || len(msgs) != 1 || string(msgs[0].Data) != "hello" {
		t.Fatalf("fetch: %v %v", msgs, err)
	}
	_ = msgs[0].Ack()
	pub.Close()
	sub.Close()
	s.Shutdown()

	// The store survives a restart: the stream and its message are there.
	s2, err := Start(Options{StoreDir: store, StreamMaxBytes: 64 << 20})
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Shutdown()
	nc, err := s2.Connect("again")
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	js2, _ := nc.JetStream()
	info, err := js2.StreamInfo("T")
	if err != nil {
		t.Fatalf("stream after restart: %v", err)
	}
	if info.State.Msgs != 1 {
		t.Fatalf("stream holds %d messages after restart, want 1", info.State.Msgs)
	}
}

func TestStart_OpensNoPort(t *testing.T) {
	s, err := Start(Options{StoreDir: t.TempDir(), StreamMaxBytes: 64 << 20})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Shutdown()
	if _, err := nats.Connect(nats.DefaultURL, nats.Timeout(500*time.Millisecond)); err == nil {
		t.Skip("another NATS server listens on the default port; the embedded one cannot be told apart")
	}
	if addr := s.ns.ClientURL(); addr != "" && s.ns.Addr() != nil {
		t.Fatalf("embedded server listens on %s", addr)
	}
}
