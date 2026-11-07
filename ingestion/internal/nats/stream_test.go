package nats

import (
	"errors"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// fakeStreams is an in-memory streamManager holding at most one
// stream. The err fields, when set, are returned by the matching call.
type fakeStreams struct {
	cfg         *nats.StreamConfig
	infoErr     error
	addErr      error
	updateErr   error
	adds        []nats.StreamConfig
	updates     []nats.StreamConfig
	infoCalls   int
	createOnAdd *nats.StreamConfig // stream "another replica" created before this add
}

func (f *fakeStreams) StreamInfo(string, ...nats.JSOpt) (*nats.StreamInfo, error) {
	f.infoCalls++
	if f.infoErr != nil {
		return nil, f.infoErr
	}
	if f.cfg == nil {
		return nil, nats.ErrStreamNotFound
	}
	return &nats.StreamInfo{Config: *f.cfg}, nil
}

func (f *fakeStreams) AddStream(cfg *nats.StreamConfig, _ ...nats.JSOpt) (*nats.StreamInfo, error) {
	f.adds = append(f.adds, *cfg)
	if f.createOnAdd != nil {
		f.cfg = f.createOnAdd
		return nil, nats.ErrStreamNameAlreadyInUse
	}
	if f.addErr != nil {
		return nil, f.addErr
	}
	c := *cfg
	f.cfg = &c
	return &nats.StreamInfo{Config: c}, nil
}

func (f *fakeStreams) UpdateStream(cfg *nats.StreamConfig, _ ...nats.JSOpt) (*nats.StreamInfo, error) {
	f.updates = append(f.updates, *cfg)
	if f.updateErr != nil {
		return nil, f.updateErr
	}
	c := *cfg
	f.cfg = &c
	return &nats.StreamInfo{Config: c}, nil
}

var testSettings = StreamSettings{MaxAge: 72 * time.Hour, MaxBytes: 5 << 30, Replicas: 3}

// unboundedStream is the stream as a release without limits created
// it: no age or size limit, one replica.
func unboundedStream() *nats.StreamConfig {
	return &nats.StreamConfig{
		Name:       streamName,
		Subjects:   streamSubjects,
		Storage:    nats.FileStorage,
		Retention:  nats.LimitsPolicy,
		Discard:    nats.DiscardOld,
		MaxBytes:   -1,
		MaxMsgs:    -1,
		Replicas:   1,
		Duplicates: 2 * time.Minute,
	}
}

func TestEnsureStreamCreatesAMissingStream(t *testing.T) {
	f := &fakeStreams{}
	if err := ensureStream(f, streamName, streamSubjects, testSettings); err != nil {
		t.Fatalf("ensureStream: %v", err)
	}
	if len(f.adds) != 1 || len(f.updates) != 0 {
		t.Fatalf("adds %d, updates %d; want one create", len(f.adds), len(f.updates))
	}
	got := f.adds[0]
	if got.Name != streamName || len(got.Subjects) != 1 || got.Subjects[0] != "events.>" ||
		got.Storage != nats.FileStorage || got.Retention != nats.LimitsPolicy || got.Discard != nats.DiscardOld ||
		got.MaxAge != testSettings.MaxAge || got.MaxBytes != testSettings.MaxBytes || got.Replicas != testSettings.Replicas {
		t.Errorf("created with %+v", got)
	}
}

func TestEnsureStreamUpdatesAnExistingStreamInPlace(t *testing.T) {
	f := &fakeStreams{cfg: unboundedStream()}
	f.cfg.Description = "kept"
	if err := ensureStream(f, streamName, streamSubjects, testSettings); err != nil {
		t.Fatalf("ensureStream: %v", err)
	}
	if len(f.adds) != 0 || len(f.updates) != 1 {
		t.Fatalf("adds %d, updates %d; want one update and no create", len(f.adds), len(f.updates))
	}
	got := f.updates[0]
	if got.MaxAge != testSettings.MaxAge || got.MaxBytes != testSettings.MaxBytes ||
		got.Replicas != testSettings.Replicas || got.Discard != nats.DiscardOld {
		t.Errorf("updated to %+v", got)
	}
	// Fields ingestion does not own are sent as the stream has them.
	if got.Description != "kept" || got.Duplicates != 2*time.Minute || got.MaxMsgs != -1 ||
		got.Storage != nats.FileStorage || got.Retention != nats.LimitsPolicy {
		t.Errorf("update changed a field ingestion does not own: %+v", got)
	}
}

func TestEnsureStreamLeavesAMatchingStreamAlone(t *testing.T) {
	cfg := streamConfig(streamName, streamSubjects, testSettings)
	f := &fakeStreams{cfg: cfg}
	if err := ensureStream(f, streamName, streamSubjects, testSettings); err != nil {
		t.Fatalf("ensureStream: %v", err)
	}
	if len(f.adds) != 0 || len(f.updates) != 0 {
		t.Fatalf("adds %d, updates %d; want neither", len(f.adds), len(f.updates))
	}
}

// Each owned field on its own differing from the settings triggers an
// update, the discard policy included.
func TestEnsureStreamUpdatesWhenAnyOwnedFieldDiffers(t *testing.T) {
	for name, change := range map[string]func(*nats.StreamConfig){
		"max_age":   func(c *nats.StreamConfig) { c.MaxAge = time.Hour },
		"max_bytes": func(c *nats.StreamConfig) { c.MaxBytes = 1 << 30 },
		"replicas":  func(c *nats.StreamConfig) { c.Replicas = 1 },
		"discard":   func(c *nats.StreamConfig) { c.Discard = nats.DiscardNew },
	} {
		t.Run(name, func(t *testing.T) {
			cfg := streamConfig(streamName, streamSubjects, testSettings)
			change(cfg)
			f := &fakeStreams{cfg: cfg}
			if err := ensureStream(f, streamName, streamSubjects, testSettings); err != nil {
				t.Fatalf("ensureStream: %v", err)
			}
			if len(f.updates) != 1 {
				t.Fatalf("updates %d, want 1", len(f.updates))
			}
			if f.cfg.MaxAge != testSettings.MaxAge || f.cfg.MaxBytes != testSettings.MaxBytes ||
				f.cfg.Replicas != testSettings.Replicas || f.cfg.Discard != nats.DiscardOld {
				t.Errorf("stream after update: %+v", f.cfg)
			}
		})
	}
}

// An update the server refuses is logged and the stream is used as it
// is: ingestion still starts.
func TestEnsureStreamToleratesARefusedUpdate(t *testing.T) {
	f := &fakeStreams{cfg: unboundedStream(), updateErr: errors.New("nats: insufficient storage resources available")}
	if err := ensureStream(f, streamName, streamSubjects, testSettings); err != nil {
		t.Fatalf("ensureStream = %v, want nil for a refused update", err)
	}
	if len(f.updates) != 1 || f.cfg.MaxBytes != -1 {
		t.Errorf("updates %d, stream max bytes %d; want one refused update and the stream unchanged",
			len(f.updates), f.cfg.MaxBytes)
	}
}

// A stream that cannot be created or read is an error: ingestion
// cannot publish without it.
func TestEnsureStreamFailsWhenTheStreamIsUnavailable(t *testing.T) {
	addFails := &fakeStreams{addErr: errors.New("nats: insufficient resources")}
	if err := ensureStream(addFails, streamName, streamSubjects, testSettings); err == nil {
		t.Error("a failed create returned nil")
	}
	infoFails := &fakeStreams{infoErr: nats.ErrJetStreamNotEnabled}
	if err := ensureStream(infoFails, streamName, streamSubjects, testSettings); !errors.Is(err, nats.ErrJetStreamNotEnabled) {
		t.Errorf("stream info failure: err = %v, want it wrapped", err)
	}
}

// Two ingestion replicas starting together: the one whose create loses
// the race reads the stream the other created and reconciles it.
func TestEnsureStreamReconcilesAStreamAnotherReplicaCreated(t *testing.T) {
	f := &fakeStreams{createOnAdd: unboundedStream()}
	if err := ensureStream(f, streamName, streamSubjects, testSettings); err != nil {
		t.Fatalf("ensureStream: %v", err)
	}
	if len(f.adds) != 1 || len(f.updates) != 1 || f.infoCalls != 2 {
		t.Fatalf("adds %d, updates %d, info calls %d; want a lost create, a re-read and an update",
			len(f.adds), len(f.updates), f.infoCalls)
	}
	if f.cfg.MaxAge != testSettings.MaxAge || f.cfg.Replicas != testSettings.Replicas {
		t.Errorf("stream after reconcile: %+v", f.cfg)
	}
}

// A stream whose storage is not file storage cannot be changed in
// place: ingestion leaves the storage and retention as they are and
// still applies the settings it owns.
func TestEnsureStreamKeepsStorageAndRetentionItCannotChange(t *testing.T) {
	cfg := unboundedStream()
	cfg.Storage = nats.MemoryStorage
	cfg.Retention = nats.InterestPolicy
	f := &fakeStreams{cfg: cfg}
	if err := ensureStream(f, streamName, streamSubjects, testSettings); err != nil {
		t.Fatalf("ensureStream: %v", err)
	}
	if len(f.updates) != 1 {
		t.Fatalf("updates %d, want 1", len(f.updates))
	}
	if got := f.updates[0]; got.Storage != nats.MemoryStorage || got.Retention != nats.InterestPolicy {
		t.Errorf("update sent storage %v retention %v; want them unchanged", got.Storage, got.Retention)
	}
}
