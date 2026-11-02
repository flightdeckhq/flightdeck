package handlers

import (
	"context"
	"slices"
	"sync"
	"time"

	"github.com/flightdeckhq/flightdeck/ingestion/internal/session"
)

// ClaudeCodeSessionStore is the session reads the Claude Code dialect
// makes before it publishes a request's events (session.Store implements
// it): LookupOTLPSession reads a session's row state and role, whether
// the run's root is stored, and whether another client already reports
// the Claude Code session; OTLPSessionEnds reads which of a request's
// sub-agents are closed and when each ended.
type ClaudeCodeSessionStore interface {
	LookupOTLPSession(ctx context.Context, sessionID, rootSessionID, claudeCodeSessionID string) (session.OTLPSession, error)
	OTLPSessionEnds(ctx context.Context, sessionIDs []string) (map[string]time.Time, error)
}

// otlpResumeTolerance is how much later than a closed sub-agent's end a
// record must be dated to resume it; a record dated at or before
// end+tolerance is late and does not reopen the sub-agent. The end and
// the record are dated by the same Claude Code clock, which dates a
// run's records before its subagent_completed, so a late record is not
// dated after the end; a resumed run's first record follows a model
// response the sub-agent gives after the resume (the parent's own turn
// that sends the message comes first), seconds after the end (4.5 s in
// the recorded resume). One second lies clear of both: it covers the
// database's microsecond rounding of the stored end and corrections
// made to the client's clock while the session runs, and stays below the
// model turns a resume takes before the sub-agent's first record.
const otlpResumeTolerance = time.Second

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
	// open: as far as the request knows, the session's row is open, so
	// its records need no synthetic session_start. A missing row or a
	// closed one is not open until the request starts it, and a
	// sub-agent's subagent_completed in the request closes it again.
	open bool
	// ended is when a closed sub-agent ended, dated by its client (its
	// latest stored session_end, or a subagent_completed earlier in the
	// request): only a record dated more than otlpResumeTolerance after
	// it starts the sub-agent again. It is zero for a root and for a
	// missing row, which their first record starts.
	ended time.Time
	// readEnd: the request reads the sub-agent's row for its end
	// (readEnds), since the session may be closed: it is cached, and any
	// replica may have published its end since, or it was read closed.
	readEnd bool
	deduped bool
	role    string
}

// startsWith reports whether rec, a record of s, is preceded by a
// synthetic session_start: s is not open, and either has no end to
// compare with (a missing row, a closed root) or ended more than
// otlpResumeTolerance before rec was dated. A record of a closed
// sub-agent dated at or before that is late, and starts nothing.
func (s *ccSession) startsWith(rec *ccRecord) bool {
	if s.open {
		return false
	}
	return s.ended.IsZero() || rec.ts.After(s.ended.Add(otlpResumeTolerance))
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
		// A cached session is open as far as this replica knows; a
		// sub-agent's end can be published by any replica, so its row is
		// read for it.
		s.cached, s.deduped, s.role, s.open = true, e.deduped, e.role, true
		s.readEnd = s.child && !s.deduped
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
	// A missing row and a closed root are started by their first record
	// in the request; a closed sub-agent only by a record dated after its
	// end, which readEnds finds.
	s.open = got.State != "" && got.State != "closed"
	s.readEnd = s.child && !s.deduped && got.State == "closed"
	if s.child {
		s.role = got.AgentRole
	}
	return s, nil
}

// readEnds reads, in one query, which of the request's sub-agents that
// may be closed are, and when each ended; the others are open. It runs
// once every session of the request is resolved, under the same
// deadline as the other reads, and a failed read fails the request.
func (r *ccResolver) readEnds() error {
	var ids []string
	for id, s := range r.sessions {
		if s.readEnd {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil
	}
	slices.Sort(ids)
	ends, err := r.d.store.OTLPSessionEnds(r.ctx, ids)
	if err != nil {
		return err
	}
	for _, id := range ids {
		s := r.sessions[id]
		ended, closed := ends[id]
		s.open, s.ended = !closed, ended
	}
	return nil
}
