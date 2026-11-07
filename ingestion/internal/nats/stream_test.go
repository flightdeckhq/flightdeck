package nats

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

// fakeStreams is an in-memory streamManager holding at most one
// stream. The err fields, when set, are returned by the matching call;
// updateErrs are returned by successive updates, one each, and once
// they run out an update succeeds.
type fakeStreams struct {
	cfg         *nats.StreamConfig
	infoErr     error
	addErr      error
	updateErrs  []error
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
	if len(f.updateErrs) > 0 {
		err := f.updateErrs[0]
		f.updateErrs = f.updateErrs[1:]
		return nil, err
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

// insufficientStorage is the API error NATS answers an update with when
// the size cannot be reserved.
var insufficientStorage = &nats.APIError{
	Code: 500, ErrorCode: 10047, Description: "insufficient storage resources available",
}

// noRetryPauses removes the pauses between update attempts for a test.
func noRetryPauses(t *testing.T) {
	t.Helper()
	saved := updateRetryDelays
	updateRetryDelays = make([]time.Duration, len(saved))
	t.Cleanup(func() { updateRetryDelays = saved })
}

// An update the server refuses is logged and the stream is used as it
// is: ingestion still starts, and the refusal is not retried.
func TestEnsureStreamToleratesARefusedUpdate(t *testing.T) {
	f := &fakeStreams{cfg: unboundedStream(), updateErrs: []error{insufficientStorage}}
	if err := ensureStream(f, streamName, streamSubjects, testSettings); err != nil {
		t.Fatalf("ensureStream = %v, want nil for a refused update", err)
	}
	if len(f.updates) != 1 || f.cfg.MaxBytes != -1 {
		t.Errorf("updates %d, stream max bytes %d; want one refused update and the stream unchanged",
			len(f.updates), f.cfg.MaxBytes)
	}
}

// An update that gets no answer is retried, and one that still gets
// none after every attempt is returned so ingestion exits and restarts.
func TestEnsureStreamReturnsAnUpdateThatGetsNoAnswer(t *testing.T) {
	noRetryPauses(t)
	errs := make([]error, len(updateRetryDelays)+1)
	for i := range errs {
		errs[i] = nats.ErrTimeout
	}
	f := &fakeStreams{cfg: unboundedStream(), updateErrs: errs}
	err := ensureStream(f, streamName, streamSubjects, testSettings)
	if !errors.Is(err, nats.ErrTimeout) {
		t.Fatalf("ensureStream = %v, want the timeout returned", err)
	}
	if want := len(updateRetryDelays) + 1; len(f.updates) != want {
		t.Errorf("updates %d, want %d attempts", len(f.updates), want)
	}
	if f.cfg.MaxBytes != -1 {
		t.Errorf("stream max bytes %d, want it unchanged", f.cfg.MaxBytes)
	}
}

// A transient failure followed by success is retried to success: no
// answer, then a leader election's 503, then the update applies.
func TestEnsureStreamRetriesATransientUpdateFailure(t *testing.T) {
	noRetryPauses(t)
	leaderElection := &nats.APIError{Code: 503, ErrorCode: 10008, Description: "JetStream system temporarily unavailable"}
	f := &fakeStreams{cfg: unboundedStream(), updateErrs: []error{nats.ErrNoResponders, leaderElection}}
	if err := ensureStream(f, streamName, streamSubjects, testSettings); err != nil {
		t.Fatalf("ensureStream: %v", err)
	}
	if len(f.updates) != 3 || f.cfg.MaxBytes != testSettings.MaxBytes {
		t.Errorf("updates %d, max bytes %d; want the third attempt to apply the settings",
			len(f.updates), f.cfg.MaxBytes)
	}
}

func TestIsRefusal(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		want bool
	}{
		{"api error", insufficientStorage, true},
		{"wrapped api error", fmt.Errorf("update: %w", insufficientStorage), true},
		{"stream not found answer", nats.ErrStreamNotFound, true},
		{"insufficient resources (503, a placement refusal)",
			&nats.APIError{Code: 503, ErrorCode: nats.JSErrCodeInsufficientResourcesErr, Description: "insufficient resources"}, true},
		{"jetstream not enabled (503)", nats.ErrJetStreamNotEnabled, true},
		{"cluster temporarily unavailable (leader election, 503)",
			&nats.APIError{Code: 503, ErrorCode: 10008, Description: "JetStream system temporarily unavailable"}, false},
		{"wrapped cluster unavailable",
			fmt.Errorf("update: %w", &nats.APIError{Code: 503, ErrorCode: 10008}), false},
		{"no leader to handle the request",
			&nats.APIError{Code: 500, ErrorCode: 10009, Description: "JetStream cluster can not handle request"}, false},
		{"stream offline",
			&nats.APIError{Code: 500, ErrorCode: 10118, Description: "stream is offline"}, false},
		{"503 with no JetStream code", &nats.APIError{Code: 503}, false},
		{"500 with no JetStream code", &nats.APIError{Code: 500, Description: "internal"}, true},
		{"timeout", nats.ErrTimeout, false},
		{"no responders", nats.ErrNoResponders, false},
		{"connection closed", nats.ErrConnectionClosed, false},
		{"other", errors.New("boom"), false},
	} {
		if got := isRefusal(tc.err); got != tc.want {
			t.Errorf("%s: isRefusal = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// A stream missing one of ingestion's subjects gets it added; a subject
// ingestion does not know is kept, not removed.
func TestEnsureStreamAddsMissingSubjectsAndKeepsOthers(t *testing.T) {
	cfg := streamConfig(streamName, []string{"audit.>"}, testSettings)
	f := &fakeStreams{cfg: cfg}
	if err := ensureStream(f, streamName, streamSubjects, testSettings); err != nil {
		t.Fatalf("ensureStream: %v", err)
	}
	if len(f.updates) != 1 {
		t.Fatalf("updates %d, want 1 although every setting already matched", len(f.updates))
	}
	got := f.updates[0].Subjects
	if len(got) != 2 || got[0] != "audit.>" || got[1] != "events.>" {
		t.Errorf("subjects sent %v, want [audit.> events.>]", got)
	}
	if len(cfg.Subjects) != 1 {
		t.Errorf("the stream's own subject list was modified: %v", cfg.Subjects)
	}
}

// A stream with an extra subject and every setting matching is left
// alone: the extra subject is only reported.
func TestEnsureStreamOnlyReportsAnExtraSubject(t *testing.T) {
	cfg := streamConfig(streamName, []string{"events.>", "audit.>"}, testSettings)
	f := &fakeStreams{cfg: cfg}
	if err := ensureStream(f, streamName, streamSubjects, testSettings); err != nil {
		t.Fatalf("ensureStream: %v", err)
	}
	if len(f.updates) != 0 {
		t.Errorf("updates %d, want none for an extra subject alone", len(f.updates))
	}
}

func TestSubjectDrift(t *testing.T) {
	missing, extra := subjectDrift([]string{"events.>", "audit.>"}, []string{"events.>", "extra.>"})
	if len(missing) != 1 || missing[0] != "extra.>" || len(extra) != 1 || extra[0] != "audit.>" {
		t.Errorf("missing %v, extra %v; want [extra.>], [audit.>]", missing, extra)
	}
	missing, extra = subjectDrift([]string{"events.>"}, []string{"events.>"})
	if missing != nil || extra != nil {
		t.Errorf("matching subjects: missing %v, extra %v; want neither", missing, extra)
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
