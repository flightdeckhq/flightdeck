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

// ensureStream creates the stream with the given settings, or brings
// an existing one to them in place.
//
// An existing stream keeps every field ingestion does not own: the
// update sends the stream's current configuration with only the limits,
// the discard policy and the replica count changed. JetStream cannot
// change a stream's storage type in place, so a stream whose storage or
// retention is not the one streamConfig sets is reported and left as it
// is; recreating it would delete its messages and is an operator's call.
//
// A stream that cannot be read, or a missing stream that cannot be
// created, is an error: ingestion cannot publish without it. An update
// the server refuses (a size above what a NATS server can reserve, more
// replicas than servers) is logged and the stream is used as it is, so
// a limits value the cluster cannot take does not stop ingestion.
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
	if current.MaxAge == s.MaxAge && current.MaxBytes == s.MaxBytes &&
		current.Discard == nats.DiscardOld && current.Replicas == s.Replicas {
		return nil
	}

	want := current
	want.MaxAge = s.MaxAge
	want.MaxBytes = s.MaxBytes
	want.Discard = nats.DiscardOld
	want.Replicas = s.Replicas
	if _, err := js.UpdateStream(&want); err != nil {
		slog.Error("stream update refused; the stream keeps its current settings",
			"stream", name, "err", err,
			"max_age", current.MaxAge, "want_max_age", s.MaxAge,
			"max_bytes", current.MaxBytes, "want_max_bytes", s.MaxBytes,
			"discard", current.Discard.String(), "want_discard", nats.DiscardOld.String(),
			"replicas", current.Replicas, "want_replicas", s.Replicas)
		return nil
	}
	slog.Info("stream updated in place", "stream", name,
		"max_age", current.MaxAge, "new_max_age", s.MaxAge,
		"max_bytes", current.MaxBytes, "new_max_bytes", s.MaxBytes,
		"discard", current.Discard.String(), "new_discard", nats.DiscardOld.String(),
		"replicas", current.Replicas, "new_replicas", s.Replicas)
	return nil
}
