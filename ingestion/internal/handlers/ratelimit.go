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

// Limit is the per-token budget: the units one window may hold.
func (rl *RateLimiter) Limit() int {
	return rl.max
}

// AllowN charges the token n units when all n fit in what is left of
// its window, and otherwise charges nothing and refuses. Returns
// (allowed, secondsUntilReset), where the seconds are how long until
// enough units age out for n to fit. n <= 0 charges nothing and admits
// while the window has a unit left, which is how a route charged per
// published event gates a request before reading its body.
//
// A charge larger than the whole budget never fits; a caller that can
// be asked for one checks Limit first and refuses it outright.
func (rl *RateLimiter) AllowN(rawToken string, n int) (bool, int) {
	need := max(n, 1)
	tw := rl.window(rawToken)
	now := time.Now()

	tw.mu.Lock()
	defer tw.mu.Unlock()

	tw.trim(now)
	if len(tw.timestamps)+need > rl.max {
		return false, rl.retryAfter(tw, now, need)
	}
	for range max(n, 0) {
		tw.timestamps = append(tw.timestamps, now)
	}
	return true, 0
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

// retryAfter is the number of seconds until need units fit in the
// window: until the units that keep them from fitting age out. A need
// larger than the budget never fits, and is answered with the whole
// window. The caller holds tw.mu and has trimmed the window.
func (rl *RateLimiter) retryAfter(tw *tokenWindow, now time.Time, need int) int {
	if need > rl.max {
		return int(rateLimitWindow.Seconds())
	}
	// The oldest len+need-max units must leave; the last of them sets
	// the wait.
	freeing := tw.timestamps[len(tw.timestamps)+need-rl.max-1]
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
