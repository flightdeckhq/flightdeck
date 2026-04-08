package handlers

import (
	"sync"
	"time"
)

const (
	rateLimitWindow   = time.Minute
	rateLimitMax      = 1000
	cleanupInterval   = 5 * time.Minute
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
}

// NewRateLimiter creates a RateLimiter and starts the cleanup goroutine.
func NewRateLimiter() *RateLimiter {
	rl := &RateLimiter{
		windows: make(map[string]*tokenWindow),
		stop:    make(chan struct{}),
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

	if len(tw.timestamps) >= rateLimitMax {
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
