package consumer

import (
	"testing"
	"time"
)

func TestRetryDelayGrowsWithTheDeliveryNumber(t *testing.T) {
	cases := map[uint64]time.Duration{
		0: retryDelayBase, // metadata unavailable: treated as the first delivery
		1: retryDelayBase,
		2: 2 * retryDelayBase,
		3: 3 * retryDelayBase,
	}
	for deliveries, want := range cases {
		if got := retryDelay(deliveries); got != want {
			t.Errorf("retryDelay(%d) = %v, want %v", deliveries, got, want)
		}
	}
}
