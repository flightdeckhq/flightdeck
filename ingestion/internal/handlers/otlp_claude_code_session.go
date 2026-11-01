package handlers

import (
	"context"
	"sync"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/session"
)

// ClaudeCodeSessionStore is the session read the Claude Code dialect
// makes before it publishes a session's first events: the session row's
// state and role, whether the run's root is stored, and whether another
// client already reports the Claude Code session (session.Store
// implements it).
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

// otlpSessionCacheSweepInterval is the least time between two sweeps of
// a full cache. A sweep walks all otlpSessionCacheMaxEntries entries
// under the cache's lock (a millisecond or two); a cache full of live
// entries would otherwise be swept on every new session. Once a second
// keeps that to a negligible share of one core, and expired entries
// still leave a full cache within a second of expiring.
const otlpSessionCacheSweepInterval = time.Second

// maxOTLPSessionReadsPerRequest bounds the session reads one export
// request may cause. Claude Code exports per process, so a batch names
// one session and the sub-agents it ran (a handful even under heavy
// fan-out); a collector merging many processes into one request names
// more, but a session costs a read only on its first export or once per
// otlpSessionCacheTTL. 64 is far above both, and bounds the database
// work a request whose session ids are invented can cause while it holds
// a decode slot. Records of sessions past it are counted as rejected; a
// later export reads them.
const maxOTLPSessionReadsPerRequest = 64

// otlpSessionLookupTimeout bounds all the session reads of one request
// together. A read is one indexed round trip, about a millisecond, so
// even maxOTLPSessionReadsPerRequest of them fit with room to spare;
// two seconds is the same wait the receiver allows for a decode slot,
// so a slow database cannot hold a slot longer than a request already
// waits for one. A request past it is answered 503 and retried.
const otlpSessionLookupTimeout = 2 * time.Second

// otlpSessionEntry is what a replica remembers about a session.
type otlpSessionEntry struct {
	expires time.Time
	// deduped: another client reports the Claude Code session, so its
	// records are not used.
	deduped bool
	// role is a sub-agent's role, once a record named it or its row
	// stored it; later records of the sub-agent that do not name it (its
	// tool results) take it from here.
	role string
}

// otlpSessionCache is the per-replica cache of session reads. It only
// saves reads: losing it (a restart, another replica) costs a read.
type otlpSessionCache struct {
	mu        sync.Mutex
	entries   map[string]otlpSessionEntry
	lastSweep time.Time
	now       func() time.Time
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
		if now.Sub(c.lastSweep) < otlpSessionCacheSweepInterval {
			return
		}
		c.lastSweep = now
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
	// capped: the request had used its reads before this session's, so
	// its records are not used (and nothing about it is cached).
	capped bool
	// needsStart: the session's first event in this request is preceded
	// by a synthetic session_start. A root needs one when its row is
	// missing or closed (a resumed session re-attaches); a sub-agent only
	// when its row is missing, since a closed one has finished and a late
	// record must not reopen it.
	needsStart   bool
	startEmitted bool
	deduped      bool
	role         string
}

// ccResolver resolves the sessions of one request, within its read cap
// and under its lookup deadline.
type ccResolver struct {
	d        *ClaudeCodeDialect
	ctx      context.Context
	sessions map[string]*ccSession
	reads    int
}

// resolve finds what the dialect needs to know about a session: from the
// replica cache, else by reading the store. A sub-agent of a run another
// client reports is deduped with it without a read of its own. A session
// past the request's read cap comes back capped; a failed read (the
// deadline included) is an error that fails the request.
func (r *ccResolver) resolve(rec *ccRecord) (*ccSession, error) {
	if s, ok := r.sessions[rec.sessionID]; ok {
		return s, nil
	}
	s := &ccSession{id: rec.sessionID, rootID: rec.rootID, child: rec.agentID != ""}
	r.sessions[s.id] = s
	if e, ok := r.d.cache.get(s.id); ok {
		s.cached, s.deduped, s.role = true, e.deduped, e.role
		return s, nil
	}
	if s.child {
		if root := r.sessions[s.rootID]; root != nil && (root.deduped || root.capped) {
			s.deduped, s.capped = root.deduped, root.capped
			return s, nil
		}
	}
	if r.reads >= maxOTLPSessionReadsPerRequest {
		s.capped = true
		return s, nil
	}
	r.reads++
	got, err := r.d.store.LookupOTLPSession(r.ctx, s.id, s.rootID, rec.claudeCodeSessionID)
	if err != nil {
		delete(r.sessions, s.id)
		return nil, err
	}
	s.deduped = !got.RootStored && got.ReportedElsewhere
	switch {
	case s.deduped:
	case got.State == "":
		s.needsStart = true
	case got.State == "closed" && !s.child:
		s.needsStart = true
	}
	if s.child {
		s.role = got.AgentRole
	}
	return s, nil
}
