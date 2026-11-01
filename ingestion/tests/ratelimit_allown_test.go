package handlers_test

import (
	"testing"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
)

// AllowN with n=0 checks the window and charges nothing, however often
// it is called, and refuses once the window is spent.
func TestRateLimitAllowNZeroChargesNothing(t *testing.T) {
	limiter := handlers.NewRateLimiter(3)
	defer limiter.Close()

	for i := range 10 {
		if allowed, _ := limiter.AllowN("tok", 0); !allowed {
			t.Fatalf("check %d refused on an unused window", i+1)
		}
	}
	for i := range 3 {
		if allowed, _ := limiter.Allow("tok"); !allowed {
			t.Fatalf("request %d refused: the checks were charged", i+1)
		}
	}
	allowed, retryAfter := limiter.AllowN("tok", 0)
	if allowed {
		t.Fatal("check admitted on a spent window")
	}
	if retryAfter < 1 || retryAfter > 61 {
		t.Errorf("Retry-After = %d, want 1..61", retryAfter)
	}
}

// AllowN charges n units, and a charge that exactly fills the budget
// is admitted.
func TestRateLimitAllowNChargesN(t *testing.T) {
	limiter := handlers.NewRateLimiter(10)
	defer limiter.Close()

	if allowed, _ := limiter.AllowN("tok", 7); !allowed {
		t.Fatal("first charge refused")
	}
	if allowed, _ := limiter.AllowN("tok", 3); !allowed {
		t.Fatal("charge exactly filling the budget refused")
	}
	if allowed, _ := limiter.AllowN("tok", 0); allowed {
		t.Fatal("check admitted on a spent window")
	}
}

// A charge larger than what is left is refused and charges nothing:
// the units that are left stay usable.
func TestRateLimitAllowNRefusesWhatDoesNotFit(t *testing.T) {
	limiter := handlers.NewRateLimiter(10)
	defer limiter.Close()

	limiter.AllowN("tok", 8)
	for range 5 {
		allowed, retryAfter := limiter.AllowN("tok", 3)
		if allowed {
			t.Fatal("charge of 3 admitted with 2 units left")
		}
		if retryAfter < 1 || retryAfter > 61 {
			t.Errorf("Retry-After = %d, want 1..61", retryAfter)
		}
	}
	if allowed, _ := limiter.AllowN("tok", 2); !allowed {
		t.Fatal("charge of 2 refused with 2 units left: a refused charge was recorded")
	}
}

// A charge larger than the whole budget never fits.
func TestRateLimitAllowNLargerThanBudget(t *testing.T) {
	limiter := handlers.NewRateLimiter(5)
	defer limiter.Close()

	allowed, retryAfter := limiter.AllowN("tok", 6)
	if allowed {
		t.Fatal("charge larger than the budget admitted on an unused window")
	}
	if retryAfter != 60 {
		t.Errorf("Retry-After = %d, want the whole window", retryAfter)
	}
	if limiter.Limit() != 5 {
		t.Errorf("Limit() = %d, want 5", limiter.Limit())
	}
	if allowed, _ := limiter.AllowN("tok", 5); !allowed {
		t.Fatal("the refused charge was recorded")
	}
}

// Windows are per token.
func TestRateLimitAllowNPerToken(t *testing.T) {
	limiter := handlers.NewRateLimiter(1)
	defer limiter.Close()

	limiter.AllowN("tok-a", 1)
	if allowed, _ := limiter.AllowN("tok-b", 1); !allowed {
		t.Fatal("tok-b refused after tok-a spent its budget")
	}
}
