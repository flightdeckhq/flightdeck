package handlers

import (
	"sync"
	"time"
)

const (
	rateLimitWindow = time.Minute
	// cleanupInterval governs how often idle token windows are
	// reaped from the in-memory map. Phase 4.5 M-22: shortened from
	// 5 min to 1 min so a deployed-token churn pattern (short-lived
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

// Allow returns true if the token has not exceeded the rate limit.
// Returns (allowed, secondsUntilReset).
func (rl *RateLimiter) Allow(tokenHash string) (bool, int) {
	rl.mu.RLock()
	tw, ok := rl.windows[tokenHash]
	rl.mu.RUnlock()

	if !ok {
		rl.mu.Lock()
		tw, ok = rl.windows[tokenHash]
		if !ok {
			tw = &tokenWindow{}
			rl.windows[tokenHash] = tw
		}
		rl.mu.Unlock()
	}

	now := time.Now()
	cutoff := now.Add(-rateLimitWindow)

	tw.mu.Lock()
	defer tw.mu.Unlock()

	// Trim timestamps outside the window
	start := 0
	for start < len(tw.timestamps) && tw.timestamps[start].Before(cutoff) {
		start++
	}
	tw.timestamps = tw.timestamps[start:]

	if len(tw.timestamps) >= rl.max {
		// Calculate seconds until the oldest timestamp exits the window
		resetAt := tw.timestamps[0].Add(rateLimitWindow)
		retryAfter := int(time.Until(resetAt).Seconds()) + 1
		if retryAfter < 1 {
			retryAfter = 1
		}
		return false, retryAfter
	}

	tw.timestamps = append(tw.timestamps, now)
	return true, 0
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
