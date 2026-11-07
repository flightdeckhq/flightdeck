package nats

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// natsTestMessages is how many messages the real-server tests publish
// before reconciling: enough to tell a kept stream from a trimmed one.
const natsTestMessages = 50

// natsTestAcked is how many of them the test consumer acknowledges, so
// the reconcile is seen to keep the consumer's place mid-stream.
const natsTestAcked = 20

// realJetStream connects to the NATS server TEST_NATS_URL names, or
// skips the test. scripts/go-db-tests.sh points it at the dev stack's
// NATS; the tests use streams of their own and delete them.
func realJetStream(t *testing.T) nats.JetStreamContext {
	t.Helper()
	url := os.Getenv("TEST_NATS_URL")
	if url == "" {
		t.Skip("no TEST_NATS_URL set; skipping the real NATS test")
	}
	nc, err := nats.Connect(url)
	if err != nil {
		t.Fatalf("connect %s: %v", url, err)
	}
	t.Cleanup(nc.Close)
	js, err := nc.JetStream()
	if err != nil {
		t.Fatalf("jetstream: %v", err)
	}
	return js
}

// testStream names a stream and subject of the test's own and deletes
// the stream when the test ends.
func testStream(t *testing.T, js nats.JetStreamContext) (string, []string) {
	t.Helper()
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		t.Fatal(err)
	}
	name := "FDTEST_STREAM_" + hex.EncodeToString(b)
	t.Cleanup(func() { _ = js.DeleteStream(name) })
	return name, []string{name + ".>"}
}

// An existing stream created without limits, as every install before
// the stream was bounded has it, is brought to the settings in place:
// its messages, sequences and consumer are kept, and publishing goes on.
func TestEnsureStreamUpdatesAnUnboundedStreamInPlaceOnNATS(t *testing.T) {
	js := realJetStream(t)
	name, subjects := testStream(t, js)

	if _, err := js.AddStream(&nats.StreamConfig{
		Name: name, Subjects: subjects, Storage: nats.FileStorage,
	}); err != nil {
		t.Fatalf("create the unbounded stream: %v", err)
	}
	subject := name + ".post_call"
	for i := range natsTestMessages {
		if _, err := js.Publish(subject, []byte(`{"n":`+strconv.Itoa(i)+`}`)); err != nil {
			t.Fatalf("publish %d: %v", i, err)
		}
	}
	durable := "fdtest-workers"
	if _, err := js.AddConsumer(name, &nats.ConsumerConfig{
		Durable: durable, AckPolicy: nats.AckExplicitPolicy, FilterSubject: subjects[0],
	}); err != nil {
		t.Fatalf("add consumer: %v", err)
	}
	sub, err := js.PullSubscribe(subjects[0], durable, nats.Bind(name, durable))
	if err != nil {
		t.Fatalf("pull subscribe: %v", err)
	}
	msgs, err := sub.Fetch(natsTestAcked, nats.MaxWait(5*time.Second))
	if err != nil || len(msgs) != natsTestAcked {
		t.Fatalf("fetch: %d messages, err %v", len(msgs), err)
	}
	for _, m := range msgs {
		if err := m.AckSync(); err != nil {
			t.Fatalf("ack: %v", err)
		}
	}

	settings := StreamSettings{MaxAge: 72 * time.Hour, MaxBytes: 64 << 20, Replicas: 1}
	if err := ensureStream(js, name, subjects, settings); err != nil {
		t.Fatalf("ensureStream: %v", err)
	}

	info, err := js.StreamInfo(name)
	if err != nil {
		t.Fatalf("stream info: %v", err)
	}
	c := info.Config
	if c.MaxAge != settings.MaxAge || c.MaxBytes != settings.MaxBytes || c.Replicas != 1 ||
		c.Discard != nats.DiscardOld || c.Storage != nats.FileStorage || c.Retention != nats.LimitsPolicy {
		t.Errorf("stream config after reconcile: max_age %v, max_bytes %d, replicas %d, discard %v, storage %v, retention %v",
			c.MaxAge, c.MaxBytes, c.Replicas, c.Discard, c.Storage, c.Retention)
	}
	if len(c.Subjects) != 1 || c.Subjects[0] != subjects[0] {
		t.Errorf("subjects after reconcile: %v", c.Subjects)
	}
	if s := info.State; s.Msgs != natsTestMessages || s.FirstSeq != 1 || s.LastSeq != natsTestMessages {
		t.Errorf("stream state after reconcile: %d messages, sequences %d..%d; want %d, 1..%d",
			s.Msgs, s.FirstSeq, s.LastSeq, natsTestMessages, natsTestMessages)
	}

	ci, err := js.ConsumerInfo(name, durable)
	if err != nil {
		t.Fatalf("consumer info after reconcile: %v", err)
	}
	if ci.AckFloor.Stream != natsTestAcked || ci.NumPending != natsTestMessages-natsTestAcked {
		t.Errorf("consumer after reconcile: ack floor %d, pending %d; want %d, %d",
			ci.AckFloor.Stream, ci.NumPending, natsTestAcked, natsTestMessages-natsTestAcked)
	}

	ack, err := js.Publish(subject, []byte(`{"after":true}`))
	if err != nil || ack.Sequence != natsTestMessages+1 {
		t.Fatalf("publish after reconcile: seq %v, err %v", ack, err)
	}
	rest, err := sub.Fetch(natsTestMessages, nats.MaxWait(5*time.Second))
	if err != nil {
		t.Fatalf("fetch after reconcile: %v", err)
	}
	if len(rest) != natsTestMessages-natsTestAcked+1 {
		t.Errorf("fetched %d messages after reconcile, want %d", len(rest), natsTestMessages-natsTestAcked+1)
	}

	// A second reconcile with the same settings changes nothing.
	if err := ensureStream(js, name, subjects, settings); err != nil {
		t.Fatalf("second ensureStream: %v", err)
	}
	again, err := js.StreamInfo(name)
	if err != nil {
		t.Fatal(err)
	}
	if again.Config.MaxAge != settings.MaxAge || again.Config.MaxBytes != settings.MaxBytes ||
		again.State.Msgs != natsTestMessages+1 {
		t.Errorf("second reconcile changed the stream: %+v, %d messages", again.Config, again.State.Msgs)
	}
}

// A size the server cannot reserve is refused by NATS; ensureStream
// logs it and leaves the stream as it was, so ingestion still starts.
func TestEnsureStreamKeepsTheStreamWhenNATSRefusesTheUpdate(t *testing.T) {
	js := realJetStream(t)
	name, subjects := testStream(t, js)
	if _, err := js.AddStream(&nats.StreamConfig{
		Name: name, Subjects: subjects, Storage: nats.FileStorage,
	}); err != nil {
		t.Fatalf("create the unbounded stream: %v", err)
	}
	// An exbibyte: more than any test server's disk.
	tooBig := StreamSettings{MaxAge: 72 * time.Hour, MaxBytes: 1 << 60, Replicas: 1}
	if err := ensureStream(js, name, subjects, tooBig); err != nil {
		t.Fatalf("ensureStream = %v, want nil for a refused update", err)
	}
	info, err := js.StreamInfo(name)
	if err != nil {
		t.Fatal(err)
	}
	if info.Config.MaxBytes != -1 || info.Config.MaxAge != 0 {
		t.Errorf("stream changed despite the refusal: max_bytes %d, max_age %v",
			info.Config.MaxBytes, info.Config.MaxAge)
	}
}

// A stream whose subjects drifted (ingestion's subject missing, another
// one added by hand) gets ingestion's subject back and keeps the other.
func TestEnsureStreamRestoresAMissingSubjectOnNATS(t *testing.T) {
	js := realJetStream(t)
	name, subjects := testStream(t, js)
	extra := name + "_EXTRA.>"
	if _, err := js.AddStream(&nats.StreamConfig{
		Name: name, Subjects: []string{extra}, Storage: nats.FileStorage,
	}); err != nil {
		t.Fatalf("create the drifted stream: %v", err)
	}
	settings := StreamSettings{MaxAge: 72 * time.Hour, MaxBytes: 64 << 20, Replicas: 1}
	if err := ensureStream(js, name, subjects, settings); err != nil {
		t.Fatalf("ensureStream: %v", err)
	}
	info, err := js.StreamInfo(name)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Config.Subjects; len(got) != 2 || got[0] != extra || got[1] != subjects[0] {
		t.Errorf("subjects after reconcile %v, want [%s %s]", got, extra, subjects[0])
	}
	if _, err := js.Publish(name+".post_call", []byte(`{}`)); err != nil {
		t.Errorf("publish on ingestion's subject after reconcile: %v", err)
	}
}

// A missing stream is created with the settings.
func TestEnsureStreamCreatesTheStreamOnNATS(t *testing.T) {
	js := realJetStream(t)
	name, subjects := testStream(t, js)
	settings := StreamSettings{MaxAge: time.Hour, MaxBytes: 64 << 20, Replicas: 1}
	if err := ensureStream(js, name, subjects, settings); err != nil {
		t.Fatalf("ensureStream: %v", err)
	}
	info, err := js.StreamInfo(name)
	if err != nil {
		t.Fatalf("stream info: %v", err)
	}
	c := info.Config
	if c.MaxAge != time.Hour || c.MaxBytes != 64<<20 || c.Discard != nats.DiscardOld ||
		c.Storage != nats.FileStorage || c.Retention != nats.LimitsPolicy {
		t.Errorf("created stream config: %+v", c)
	}
}
