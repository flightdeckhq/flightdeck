package nats

import (
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/nats-io/nats.go"
)

// StreamSettings are the FLIGHTDECK stream's settings that ingestion
// owns and keeps in place: its two limits and its replica count. The
// rest of the stream's configuration is fixed (see streamConfig).
type StreamSettings struct {
	// MaxAge is how long the stream keeps a message, processed or not.
	MaxAge time.Duration
	// MaxBytes is the most the stream stores on each server; at the
	// limit the oldest messages are removed.
	MaxBytes int64
	// Replicas is how many NATS servers hold a copy of the stream.
	Replicas int
}

// streamManager is the part of nats.JetStreamContext that ensureStream
// uses, so the reconcile logic can be tested without a server.
type streamManager interface {
	StreamInfo(stream string, opts ...nats.JSOpt) (*nats.StreamInfo, error)
	AddStream(cfg *nats.StreamConfig, opts ...nats.JSOpt) (*nats.StreamInfo, error)
	UpdateStream(cfg *nats.StreamConfig, opts ...nats.JSOpt) (*nats.StreamInfo, error)
}

// streamConfig is the configuration a missing stream is created with.
// Retention is by limits, so a message stays until its age or the
// stream's size removes it, acknowledged or not; at the size limit the
// oldest messages are discarded, since a stream of processed messages
// refusing new ones would drop every event published once it filled.
func streamConfig(name string, subjects []string, s StreamSettings) *nats.StreamConfig {
	return &nats.StreamConfig{
		Name:      name,
		Subjects:  subjects,
		Storage:   nats.FileStorage,
		Retention: nats.LimitsPolicy,
		Discard:   nats.DiscardOld,
		MaxAge:    s.MaxAge,
		MaxBytes:  s.MaxBytes,
		Replicas:  s.Replicas,
	}
}

// updateRetryDelays are the pauses between the attempts of a stream
// update that failed without an answer from the server (a timeout, no
// responders, a dropped connection): four attempts in all, 1.75 s of
// pauses. Each attempt waits up to the JetStream request timeout (5 s),
// so a NATS that never answers is given up on after about 22 s, inside
// the Helm chart's ingestion liveness budget (15 s delay plus three
// failed 10 s probes); ingestion then exits and its supervisor starts
// it again. A refusal is an answer and is not retried.
var updateRetryDelays = []time.Duration{
	250 * time.Millisecond,
	500 * time.Millisecond,
	time.Second,
}

// ensureStream creates the stream with the given settings, or brings
// an existing one to them in place.
//
// An existing stream keeps every field ingestion does not own: the
// update sends the stream's current configuration with only the limits,
// the discard policy and the replica count changed, and any of the
// given subjects it lacks added. A subject the stream has beyond them
// is reported and kept, since removing it could drop messages someone
// else publishes. JetStream cannot change a stream's storage type in
// place, so a stream whose storage or retention is not the one
// streamConfig sets is reported and left as it is; recreating it would
// delete its messages and is an operator's call.
//
// A stream that cannot be read, or a missing stream that cannot be
// created, is an error: ingestion cannot publish without it. An update
// the server refuses (a size above what a NATS server can reserve, more
// replicas than servers) is logged and the stream is used as it is, so
// a limits value the cluster cannot take does not stop ingestion. An
// update that gets no answer is retried (updateRetryDelays) and then
// returned as an error.
func ensureStream(js streamManager, name string, subjects []string, s StreamSettings) error {
	info, err := js.StreamInfo(name)
	if errors.Is(err, nats.ErrStreamNotFound) {
		_, cerr := js.AddStream(streamConfig(name, subjects, s))
		if cerr == nil {
			slog.Info("stream created", "stream", name, "max_age", s.MaxAge,
				"max_bytes", s.MaxBytes, "replicas", s.Replicas)
			return nil
		}
		// Another ingestion replica created it first: reconcile that one.
		if !errors.Is(cerr, nats.ErrStreamNameAlreadyInUse) {
			return fmt.Errorf("create stream %s: %w", name, cerr)
		}
		info, err = js.StreamInfo(name)
	}
	if err != nil {
		return fmt.Errorf("stream info %s: %w", name, err)
	}

	current := info.Config
	if current.Storage != nats.FileStorage || current.Retention != nats.LimitsPolicy {
		slog.Error("stream storage or retention differs from what ingestion creates; left as it is",
			"stream", name, "storage", current.Storage.String(), "want_storage", nats.FileStorage.String(),
			"retention", current.Retention.String(), "want_retention", nats.LimitsPolicy.String())
	}
	missing, extra := subjectDrift(current.Subjects, subjects)
	if len(extra) > 0 {
		slog.Warn("stream has subjects ingestion does not publish to; kept",
			"stream", name, "subjects", extra)
	}
	if len(missing) == 0 && current.MaxAge == s.MaxAge && current.MaxBytes == s.MaxBytes &&
		current.Discard == nats.DiscardOld && current.Replicas == s.Replicas {
		return nil
	}

	want := current
	want.Subjects = append(append([]string(nil), current.Subjects...), missing...)
	want.MaxAge = s.MaxAge
	want.MaxBytes = s.MaxBytes
	want.Discard = nats.DiscardOld
	want.Replicas = s.Replicas
	attrs := []any{"stream", name,
		"max_age", current.MaxAge, "want_max_age", s.MaxAge,
		"max_bytes", current.MaxBytes, "want_max_bytes", s.MaxBytes,
		"discard", current.Discard.String(), "want_discard", nats.DiscardOld.String(),
		"replicas", current.Replicas, "want_replicas", s.Replicas,
		"added_subjects", missing}

	for attempt := 0; ; attempt++ {
		_, err := js.UpdateStream(&want)
		if err == nil {
			slog.Info("stream updated in place", attrs...)
			return nil
		}
		if isRefusal(err) {
			slog.Error("stream update refused; the stream keeps its current settings",
				append([]any{"err", err}, attrs...)...)
			return nil
		}
		if attempt == len(updateRetryDelays) {
			return fmt.Errorf("update stream %s: no answer after %d attempts: %w",
				name, attempt+1, err)
		}
		slog.Warn("stream update got no answer; retrying",
			"stream", name, "attempt", attempt+1, "err", err)
		time.Sleep(updateRetryDelays[attempt])
	}
}

// isRefusal reports whether err is the server's answer to a request
// (a JetStream API error) rather than a failure to get one.
func isRefusal(err error) bool {
	var jsErr nats.JetStreamError
	return errors.As(err, &jsErr) && jsErr.APIError() != nil
}

// subjectDrift compares a stream's subjects with the ones ingestion
// publishes to: missing are ingestion's subjects the stream lacks,
// extra the stream's subjects ingestion does not know.
func subjectDrift(current, want []string) (missing, extra []string) {
	have := make(map[string]bool, len(current))
	for _, subj := range current {
		have[subj] = true
	}
	known := make(map[string]bool, len(want))
	for _, subj := range want {
		known[subj] = true
		if !have[subj] {
			missing = append(missing, subj)
		}
	}
	for _, subj := range current {
		if !known[subj] {
			extra = append(extra, subj)
		}
	}
	return missing, extra
}
