# `POST /v1/admin/reconcile-agents`

Operator endpoint that makes the `agents` table correct in one call.
Single-tier auth: any valid bearer token is accepted (D156).
Production deployments protect this route at the network boundary
(firewall / ingress) rather than via token scopes — `/v1/admin/*` is
intended for operator interfaces, not the dashboard.

Two-phase operation:

1. **Recompute counters.** Recomputes the denormalised rollup
   columns on every `agents` row from the `sessions` table ground
   truth (per-agent transaction; continues on per-agent error).
2. **Reap stale orphans.** Deletes `agents` rows whose post-
   reconcile `total_sessions = 0` AND `last_seen_at < NOW() -
   orphan_threshold_secs`. Default threshold is 30 days. Pass
   `orphan_threshold_secs=0` to skip the delete step (counters-
   only mode).

## When to call

- After a data cleanup (manual `DELETE` against `sessions` or
  `agents` tables).
- After a schema migration that touched denormalised columns.
- When the Fleet page shows implausible run counts
  (`total_sessions` unrealistically high vs visible run
  rows).
- When stale orphan rows from old test runs / smoke fixtures
  are crowding the AGENT facet, the `/v1/agents` listing, or
  the agent-id resolver chain.
- Not on a schedule. The endpoint is for targeted operator
  action; scheduling is explicitly out of scope for v1.

## Phase 1 — counter reconciliation

Columns reconciled:

| Column           | Ground truth source                            |
|------------------|-----------------------------------------------|
| `total_sessions` | `COUNT(*)` on `sessions` grouped by agent      |
| `total_tokens`   | `COALESCE(SUM(tokens_used), 0)` on sessions    |
| `first_seen_at`  | `MIN(started_at)` on sessions                  |
| `last_seen_at`   | `MAX(last_seen_at)` on sessions                |

For an agent with zero actual runs: `total_sessions` and
`total_tokens` are zeroed; `first_seen_at` and `last_seen_at` are
preserved (overwriting those with NULL via MIN/MAX over an empty
set would lose the original UpsertAgent timestamps).

## Phase 2 — orphan deletion

After phase 1, rows where `total_sessions = 0` AND `last_seen_at <
NOW() - orphan_threshold` are physically deleted. The two-clause
predicate keeps the operation safe:

- `total_sessions = 0` rules out any agent that ever had a real
  run.
- The staleness clause rules out a freshly upserted agent that the
  worker has not yet wired up to a `session_start` row (the race
  the bare `total_sessions = 0` predicate would lose against the
  seed.py / sensor `init()` handshake).

Per-row DELETE so a single bad row (FK violation, race-promoted
to non-orphan between phases) doesn't abort the sweep. The DELETE
restates the predicate so a row promoted between SELECT and DELETE
is silently skipped.

## Request

```
POST /v1/admin/reconcile-agents
POST /v1/admin/reconcile-agents?orphan_threshold_secs=86400   # 1 day window
POST /v1/admin/reconcile-agents?orphan_threshold_secs=0        # skip delete
Authorization: Bearer <token>
```

No body.

| Query param              | Default       | Notes                                                  |
|--------------------------|---------------|--------------------------------------------------------|
| `orphan_threshold_secs`  | `2592000` (30d) | `0` skips the delete step. Values 1..59 → 400.       |

## Response

```json
{
  "agents_scanned": 46,
  "agents_updated": 3,
  "counters_updated": {
    "total_sessions": 2,
    "total_tokens": 1,
    "last_seen_at": 3
  },
  "agents_deleted": 5,
  "delete_threshold": "720h0m0s",
  "duration_ms": 42,
  "errors": []
}
```

- `agents_scanned` — total agents inspected during reconciliation.
- `agents_updated` — how many agents had at least one column
  corrected.
- `counters_updated` — per-column tally of how many agents had
  that column corrected. Present only when non-empty.
- `agents_deleted` — count of orphan rows physically deleted by
  phase 2. Zero when `orphan_threshold_secs=0`.
- `delete_threshold` — human-readable form of the cutoff applied
  in phase 2 (Go `time.Duration.String()` form). Empty string
  when phase 2 was skipped.
- `duration_ms` — wall-clock time for the full operation
  (reconcile + delete).
- `errors` — per-row failures from either phase. Empty on clean
  success.

## Status codes

| Code | Meaning |
|------|---------|
| 200  | Operation completed; `errors` is empty |
| 207  | Operation completed with per-row errors (`errors` non-empty, otherwise identical shape) |
| 400  | `orphan_threshold_secs` malformed or in the rejected `1..59` range |
| 401  | Missing or invalid bearer token |
| 409  | Another reconcile is already in progress (process-level mutex) |
| 500  | Fatal database error (pool exhausted, list query failure) |

## Concurrency

The endpoint serialises concurrent calls within a single API
replica via a `sync.Mutex.TryLock`. Multi-replica deployments
would require cross-process coordination; not solved pre-
emptively because the single-replica case is the v1 deployment
shape. A future revision can layer a Postgres advisory lock.

## Performance

O(n) in agent count. Each agent is two queries plus at most one
UPDATE. On the dev stack (~50 agents) a full scan completes in
30-50ms. At 10k agents expect ~5s — within a normal admin
request window, no pagination needed for v1.

## Concurrency with the worker

Reconcile is NOT atomic against concurrent worker writes. The
worker's `BumpAgentSessionCount` / `IncrementAgentTokens` execute
`SET col = col + N` as deltas; if a bump lands between our
`SELECT COUNT(*)` and `UPDATE SET`, the bump overshoots by that
delta and creates small drift the NEXT reconcile fixes. Bounded
by per-agent events-per-second during reconcile; admin invocation
is rare enough that residual drift converges over subsequent
calls. Invoke during quiet windows if strict-zero residual drift
matters.

## Example — dev stack

```bash
# Default: reconcile counters + delete orphans older than 30d.
curl -s -X POST \
  -H 'Authorization: Bearer tok_dev' \
  http://localhost:4000/api/v1/admin/reconcile-agents | jq

# Counters-only — leave orphan rows alone.
curl -s -X POST \
  -H 'Authorization: Bearer tok_dev' \
  'http://localhost:4000/api/v1/admin/reconcile-agents?orphan_threshold_secs=0' | jq

# Aggressive cleanup of test-run drift: reap any orphan older than 1 hour.
curl -s -X POST \
  -H 'Authorization: Bearer tok_dev' \
  'http://localhost:4000/api/v1/admin/reconcile-agents?orphan_threshold_secs=3600' | jq
```

Expected output on a freshly-seeded dev stack: zero corrections,
zero deletions (the canonical fixtures are consistent and recent).
On a dev stack with accumulated test-run drift, expect a non-zero
`counters_updated.total_sessions` and a non-zero `agents_deleted`
when the threshold is tighter than 30d.
