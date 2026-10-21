package consumer

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/nats-io/nats.go"
)

func TestDecideDeliveryAcksRetriesAndTerminates(t *testing.T) {
	failure := errors.New("database down")
	cases := []struct {
		name       string
		err        error
		deliveries uint64
		want       deliveryOutcome
		delay      time.Duration
	}{
		{"processed", nil, 1, outcomeAck, 0},
		{"processed on the final delivery", nil, maxDeliver, outcomeAck, 0},
		{"retry requested, first delivery", ErrRetryLater, 1, outcomeRetry, retryDelayBase},
		{"retry requested, second delivery", ErrRetryLater, 2, outcomeRetry, 2 * retryDelayBase},
		{"retry requested on the final delivery", ErrRetryLater, maxDeliver, outcomeTerm, 0},
		{"wrapped retry request", fmt.Errorf("session_end: %w", ErrRetryLater), 1, outcomeRetry, retryDelayBase},
		{"failure, first delivery", failure, 1, outcomeRetry, retryDelayBase},
		{"failure, second delivery", failure, 2, outcomeRetry, 2 * retryDelayBase},
		{"failure on the final delivery", failure, maxDeliver, outcomeTerm, 0},
		{"recovered panic on the final delivery", fmt.Errorf("panic: %v", "boom"), maxDeliver, outcomeTerm, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, delay := decideDelivery(tc.err, tc.deliveries)
			if got != tc.want || delay != tc.delay {
				t.Fatalf("decideDelivery(%v, %d) = (%v, %v), want (%v, %v)",
					tc.err, tc.deliveries, got, delay, tc.want, tc.delay)
			}
		})
	}
}

func TestDeliveryNumberTreatsMissingMetadataAsFinal(t *testing.T) {
	if got := deliveryNumber(nil, errors.New("not a JetStream message")); got != maxDeliver {
		t.Fatalf("missing metadata counted as delivery %d, want %d", got, maxDeliver)
	}
	if got := deliveryNumber(nil, nil); got != maxDeliver {
		t.Fatalf("nil metadata counted as delivery %d, want %d", got, maxDeliver)
	}
	if got := deliveryNumber(&nats.MsgMetadata{NumDelivered: 2}, nil); got != 2 {
		t.Fatalf("delivery number = %d, want 2", got)
	}
}
