package handlers

import (
	"context"
	"sync"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/session"
)

// ClaudeCodeSessionStore is the session read the Claude Code dialect
// makes before it publishes a session's first events: the session row's
// state, whether the run's root is stored, and whether another client
// already reports the Claude Code session (session.Store implements it).
type ClaudeCodeSessionStore interface {
	LookupOTLPSession(ctx context.Context, sessionID, rootSessionID, claudeCodeSessionID string) (session.OTLPSession, error)
}

// otlpSessionCacheTTL is how long a replica trusts what it read about a
// session. Ten minutes is well inside the orphan reaper's timeout (24
// hours by default), the only thing besides a session_end that closes a
// session reported over OTLP, so a session the reaper closes is read
// again, and re-attached, well before anyone could rely on it staying
// closed; and it is long enough that a busy session costs one read per
// ten minutes rather than one per export (Claude Code exports logs every
// few seconds).
const otlpSessionCacheTTL = 10 * time.Minute

// otlpSessionCacheMaxEntries bounds the cache. Each entry is a session
// seen within the TTL, about 150 bytes, so the bound is about 7.5 MB per
// replica: far above any real fleet's sessions per ten minutes, and a
// ceiling on what a token holder inventing session ids can make the
// replica hold. A full cache is swept of expired entries; still full,
// new sessions are read on every export instead of cached.
const otlpSessionCacheMaxEntries = 50_000

// otlpSessionEntry is what a replica remembers about a session.
type otlpSessionEntry struct {
	expires time.Time
	// deduped: another client reports the Claude Code session, so its
	// records are not used.
	deduped bool
	// role is a sub-agent's role, once a record named it; later records
	// of the sub-agent that do not (its tool results) take it from here.
	role string
}

// otlpSessionCache is the per-replica cache of session reads. It only
// saves reads: losing it (a restart, another replica) costs a read.
type otlpSessionCache struct {
	mu      sync.Mutex
	entries map[string]otlpSessionEntry
	now     func() time.Time
}

func newOTLPSessionCache(now func() time.Time) *otlpSessionCache {
	return &otlpSessionCache{entries: map[string]otlpSessionEntry{}, now: now}
}

func (c *otlpSessionCache) get(sessionID string) (otlpSessionEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[sessionID]
	if !ok {
		return otlpSessionEntry{}, false
	}
	if !c.now().Before(e.expires) {
		delete(c.entries, sessionID)
		return otlpSessionEntry{}, false
	}
	return e, true
}

// put caches what was read about a session for otlpSessionCacheTTL. An
// entry already cached keeps its expiry, so a session is read again at
// least every TTL however busy it is.
func (c *otlpSessionCache) put(sessionID string, deduped bool, role string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	if e, ok := c.entries[sessionID]; ok && now.Before(e.expires) {
		if role != "" {
			e.role = role
			c.entries[sessionID] = e
		}
		return
	}
	if len(c.entries) >= otlpSessionCacheMaxEntries {
		for id, e := range c.entries {
			if !now.Before(e.expires) {
				delete(c.entries, id)
			}
		}
		if len(c.entries) >= otlpSessionCacheMaxEntries {
			return
		}
	}
	c.entries[sessionID] = otlpSessionEntry{expires: now.Add(otlpSessionCacheTTL), deduped: deduped, role: role}
}

// drop forgets a session, so its next record is read again: publishing
// a session's session_end drops it, and a record for the session after
// the end re-attaches it.
func (c *otlpSessionCache) drop(sessionID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, sessionID)
}

func (c *otlpSessionCache) len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.entries)
}

// ccSession is one Flightdeck session a request's records belong to.
type ccSession struct {
	id     string // Flightdeck session id
	rootID string // the run's root session id (id itself for a root)
	child  bool
	cached bool // known from the replica cache; nothing was read
	// needsStart: the row is missing or closed, so the session's first
	// event in this request is preceded by a synthetic session_start.
	needsStart   bool
	startEmitted bool
	deduped      bool
	role         string
}

// resolveSession finds what the dialect needs to know about a session:
// from the replica cache, else by reading the store. A sub-agent of a
// run another client reports is deduped with it without a read of its
// own.
func (d *ClaudeCodeDialect) resolveSession(ctx context.Context, sessions map[string]*ccSession, rec *ccRecord) (*ccSession, error) {
	if s, ok := sessions[rec.sessionID]; ok {
		return s, nil
	}
	s := &ccSession{id: rec.sessionID, rootID: rec.rootID, child: rec.agentID != ""}
	sessions[s.id] = s
	if e, ok := d.cache.get(s.id); ok {
		s.cached, s.deduped, s.role = true, e.deduped, e.role
		return s, nil
	}
	if s.child {
		if root := sessions[s.rootID]; root != nil && root.deduped {
			s.deduped = true
			return s, nil
		}
	}
	got, err := d.store.LookupOTLPSession(ctx, s.id, s.rootID, rec.claudeCodeSessionID)
	if err != nil {
		delete(sessions, s.id)
		return nil, err
	}
	s.deduped = !got.RootStored && got.ReportedElsewhere
	s.needsStart = !s.deduped && (got.State == "" || got.State == "closed")
	return s, nil
}
