package handlers_test

import (
	"testing"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/handlers"
)

// AllowN with n=0 checks the window and charges nothing, however often
// it is called.
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
	if allowed, _ := limiter.Allow("tok"); allowed {
		t.Fatal("fourth request admitted past a budget of 3")
	}
}

// AllowN charges n units: a charge that fills the budget leaves the
// next request refused.
func TestRateLimitAllowNChargesN(t *testing.T) {
	limiter := handlers.NewRateLimiter(10)
	defer limiter.Close()

	if allowed, _ := limiter.AllowN("tok", 7); !allowed {
		t.Fatal("first charge refused")
	}
	if allowed, _ := limiter.AllowN("tok", 3); !allowed {
		t.Fatal("charge up to the budget refused")
	}
	allowed, retryAfter := limiter.AllowN("tok", 0)
	if allowed {
		t.Fatal("check admitted on a spent window")
	}
	if retryAfter < 1 {
		t.Errorf("Retry-After = %d, want >= 1", retryAfter)
	}
}

// A charge larger than what is left is admitted while a unit is left,
// and the window then refuses until it ages out: no request is refused
// for ever because it is larger than what remains.
func TestRateLimitAllowNOverdrawsOnce(t *testing.T) {
	limiter := handlers.NewRateLimiter(10)
	defer limiter.Close()

	limiter.AllowN("tok", 9)
	if allowed, _ := limiter.AllowN("tok", 5); !allowed {
		t.Fatal("charge refused while one unit was left")
	}
	if allowed, _ := limiter.Allow("tok"); allowed {
		t.Fatal("request admitted on an overdrawn window")
	}
}

// A charge is capped at the minute budget, so a request larger than
// the budget does not lock the token out for longer than one window.
func TestRateLimitAllowNCappedAtBudget(t *testing.T) {
	limiter := handlers.NewRateLimiter(5)
	defer limiter.Close()

	if allowed, _ := limiter.AllowN("tok", 1_000_000); !allowed {
		t.Fatal("charge larger than the budget refused on an unused window")
	}
	allowed, retryAfter := limiter.Allow("tok")
	if allowed {
		t.Fatal("request admitted after a full-budget charge")
	}
	// Capped at the budget, the window frees up within one minute.
	if retryAfter < 1 || retryAfter > 61 {
		t.Errorf("Retry-After = %d, want 1..61", retryAfter)
	}
}

// A refused AllowN charges nothing: the units it would have taken do
// not extend the lockout.
func TestRateLimitAllowNRefusedChargesNothing(t *testing.T) {
	limiter := handlers.NewRateLimiter(2)
	defer limiter.Close()

	limiter.AllowN("tok", 2)
	for range 5 {
		if allowed, _ := limiter.AllowN("tok", 100); allowed {
			t.Fatal("charge admitted on a spent window")
		}
	}
	_, retryAfter := limiter.AllowN("tok", 0)
	if retryAfter > 61 {
		t.Errorf("Retry-After = %d: refused charges were recorded", retryAfter)
	}
}

// ChargeN charges whatever the window holds, capped at the budget, and
// charges nothing for n <= 0.
func TestRateLimitChargeN(t *testing.T) {
	limiter := handlers.NewRateLimiter(4)
	defer limiter.Close()

	limiter.ChargeN("tok", 0)
	limiter.ChargeN("tok", -3)
	if allowed, _ := limiter.AllowN("tok", 0); !allowed {
		t.Fatal("non-positive ChargeN charged the window")
	}

	limiter.ChargeN("tok", 4)
	if allowed, _ := limiter.AllowN("tok", 0); allowed {
		t.Fatal("window not spent after a full-budget ChargeN")
	}
	// Charging a spent window still records the units (capped), so
	// concurrent requests that passed the gate are all charged.
	limiter.ChargeN("tok", 1_000)
	if allowed, _ := limiter.Allow("tok"); allowed {
		t.Fatal("request admitted after charging a spent window")
	}
}

// Windows are per token.
func TestRateLimitAllowNPerToken(t *testing.T) {
	limiter := handlers.NewRateLimiter(1)
	defer limiter.Close()

	limiter.AllowN("tok-a", 1)
	if allowed, _ := limiter.AllowN("tok-b", 0); !allowed {
		t.Fatal("tok-b refused after tok-a spent its budget")
	}
}
