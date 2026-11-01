package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
	"time"
)

const (
	rateLimitWindow = time.Minute
	// cleanupInterval governs how often idle token windows are
	// reaped from the in-memory map. One minute rather than five, so
	// a deployed-token churn pattern (short-lived
	// tokens that auth, hit the limiter once, then never appear
	// again) cannot keep dead entries in memory for up to 5 minutes.
	// Auth runs BEFORE Allow(), so the keys are bounded by deployed
	// token count regardless; this just tightens the steady-state
	// upper bound on map size.
	cleanupInterval = time.Minute
	// DefaultRateLimitPerMinute is the per-token sliding window cap
	// applied when no override is configured. Production deployments
	// that do not set FLIGHTDECK_RATE_LIMIT_PER_MINUTE inherit this
	// value via cmd/main.go -> NewRateLimiter, so the production
	// behavior is unchanged. Tests and dev compose can pass higher
	// values to avoid hammering the limit during fast test loops.
	DefaultRateLimitPerMinute = 1000
)

type tokenWindow struct {
	timestamps []time.Time
	mu         sync.Mutex
}

// RateLimiter enforces per-token rate limits using a sliding window.
type RateLimiter struct {
	windows map[string]*tokenWindow
	mu      sync.RWMutex
	stop    chan struct{}
	max     int
}

// NewRateLimiter creates a RateLimiter capped at ``max`` requests per
// minute per token and starts the cleanup goroutine. Pass
// DefaultRateLimitPerMinute (1000) for production semantics, or a
// higher value in dev / test environments where the integration
// suite shares one token across many tests run back-to-back.
//
// max <= 0 falls back to DefaultRateLimitPerMinute so a misconfigured
// env var cannot disable the limiter entirely on accident.
func NewRateLimiter(max int) *RateLimiter {
	if max <= 0 {
		max = DefaultRateLimitPerMinute
	}
	rl := &RateLimiter{
		windows: make(map[string]*tokenWindow),
		stop:    make(chan struct{}),
		max:     max,
	}
	go rl.cleanupLoop()
	return rl
}

// Allow returns true if the token has not exceeded the rate limit,
// charging one unit. Returns (allowed, secondsUntilReset).
func (rl *RateLimiter) Allow(rawToken string) (bool, int) {
	return rl.AllowN(rawToken, 1)
}

// AllowN admits a request when the token's window has at least one
// unit left and then charges it n units, at most the whole minute
// budget. Returns (allowed, secondsUntilReset); a refused request is
// charged nothing. n <= 0 checks the window without charging it, which
// is how a route that is charged per published event gates a request
// before reading its body.
//
// A charge may take the window past its budget: the request that does
// so is admitted, and later ones are refused until enough units age
// out. Capping the charge at the budget is what keeps a request larger
// than the budget from being refused for ever.
func (rl *RateLimiter) AllowN(rawToken string, n int) (bool, int) {
	tw := rl.window(rawToken)
	now := time.Now()

	tw.mu.Lock()
	defer tw.mu.Unlock()

	tw.trim(now)
	if len(tw.timestamps) >= rl.max {
		return false, rl.retryAfter(tw, now)
	}
	rl.charge(tw, now, n)
	return true, 0
}

// ChargeN charges the token n units, at most the whole minute budget,
// whatever its window holds. It is for work already admitted by AllowN
// and already done, such as events published after the request's
// gate: charging it unconditionally keeps concurrent requests that all
// passed the gate from going uncharged.
func (rl *RateLimiter) ChargeN(rawToken string, n int) {
	if n <= 0 {
		return
	}
	tw := rl.window(rawToken)
	now := time.Now()

	tw.mu.Lock()
	defer tw.mu.Unlock()

	tw.trim(now)
	rl.charge(tw, now, n)
}

// window returns the token's sliding window, creating it on first use.
//
// The raw bearer token is hashed before it is used as a map key so the
// plaintext secret is never held in the limiter's in-memory state (a
// heap dump cannot recover it), mirroring the auth validator's cache.
func (rl *RateLimiter) window(rawToken string) *tokenWindow {
	sum := sha256.Sum256([]byte(rawToken))
	tokenHash := hex.EncodeToString(sum[:])

	rl.mu.RLock()
	tw, ok := rl.windows[tokenHash]
	rl.mu.RUnlock()
	if ok {
		return tw
	}

	rl.mu.Lock()
	defer rl.mu.Unlock()
	tw, ok = rl.windows[tokenHash]
	if !ok {
		tw = &tokenWindow{}
		rl.windows[tokenHash] = tw
	}
	return tw
}

// trim drops the timestamps that have left the window. The caller
// holds tw.mu.
func (tw *tokenWindow) trim(now time.Time) {
	cutoff := now.Add(-rateLimitWindow)
	start := 0
	for start < len(tw.timestamps) && tw.timestamps[start].Before(cutoff) {
		start++
	}
	tw.timestamps = tw.timestamps[start:]
}

// charge appends n units at now, at most the whole budget. The caller
// holds tw.mu.
func (rl *RateLimiter) charge(tw *tokenWindow, now time.Time, n int) {
	n = min(n, rl.max)
	for range n {
		tw.timestamps = append(tw.timestamps, now)
	}
}

// retryAfter is the number of seconds until the window has a unit
// left: until the unit that brings it back under the budget ages out.
// A window charged past its budget needs more than its oldest unit to
// expire. The caller holds tw.mu and has trimmed the window.
func (rl *RateLimiter) retryAfter(tw *tokenWindow, now time.Time) int {
	freeing := tw.timestamps[len(tw.timestamps)-rl.max]
	secs := int(freeing.Add(rateLimitWindow).Sub(now).Seconds()) + 1
	return max(secs, 1)
}

func (rl *RateLimiter) cleanupLoop() {
	ticker := time.NewTicker(cleanupInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			rl.cleanup()
		case <-rl.stop:
			return
		}
	}
}

func (rl *RateLimiter) cleanup() {
	cutoff := time.Now().Add(-rateLimitWindow)
	rl.mu.Lock()
	defer rl.mu.Unlock()
	for key, tw := range rl.windows {
		tw.mu.Lock()
		if len(tw.timestamps) == 0 || tw.timestamps[len(tw.timestamps)-1].Before(cutoff) {
			delete(rl.windows, key)
		}
		tw.mu.Unlock()
	}
}

// Close stops the cleanup goroutine.
func (rl *RateLimiter) Close() {
	close(rl.stop)
}
