# Admin endpoints

Operator-only endpoints on the query API. Gated by
`auth.AdminRequired` which requires a token that resolves to
`IsAdmin=true`. Missing/invalid tokens receive 401; valid
non-admin tokens (e.g. the regular `tok_dev` dev bearer) receive
403. The admin token is an out-of-band secret, NOT a user token —
do not store it in the dashboard, do not commit it to config
files.

## Admin token configuration

**Dev mode** (local stack, `ENVIRONMENT=dev`): the hardcoded
shortcut `tok_admin_dev` authenticates as admin. Mirrors the
`tok_dev` convention for regular dev bearers. Zero configuration
required.

**Production** (`ENVIRONMENT!=dev`): set the environment variable
`FLIGHTDECK_ADMIN_ACCESS_TOKEN` on the api container. Any bearer
whose raw value matches this env var authenticates as admin
(constant-time comparison). Unset → no admin access anywhere,
which is the safe default.

Admin is a SUPERSET of the regular bearer gate — an admin token
also passes the plain `/v1/*` read endpoints. Operators need a
single token, not two. Token rotation is a simple env-var update
+ api restart.

## POST /v1/admin/reconcile-agents

Recomputes the denormalised rollup counters on every `agents` row
from the `sessions` table ground truth. Per-agent transaction;
continues on per-agent error.

### When to call

- After a data cleanup (manual `DELETE` against `sessions` or
  `agents` tables).
- After a schema migration that touched denormalised columns.
- When the Fleet page shows implausible session counts
  (`total_sessions` unrealistically high vs visible session
  rows).
- Not on a schedule. The endpoint is for targeted operator
  action; scheduling is explicitly out of scope for v1 (if
  drift turns out to be frequent in production, a scheduled
  worker reconciler replaces this endpoint as a follow-up).

### Behaviour

Columns reconciled:

| Column           | Ground truth source                            |
|------------------|-----------------------------------------------|
| `total_sessions` | `COUNT(*)` on `sessions` grouped by agent      |
| `total_tokens`   | `COALESCE(SUM(tokens_used), 0)` on sessions    |
| `first_seen_at`  | `MIN(started_at)` on sessions                  |
| `last_seen_at`   | `MAX(last_seen_at)` on sessions                |

Conservative orphan policy: an agent with zero actual sessions
has `total_sessions` and `total_tokens` zeroed but `first_seen_at`
and `last_seen_at` are preserved. Overwriting those with NULL
(MIN/MAX over an empty set) would be semantically wrong; the
values carry ground-truth information about when the agent row
itself appeared. Orphan-row cleanup is a separate concern and a
separate PR if needed.

### Request

```
POST /v1/admin/reconcile-agents
Authorization: Bearer <admin-token>
```

No body.

### Response

```json
{
  "agents_scanned": 46,
  "agents_updated": 3,
  "counters_updated": {
    "total_sessions": 2,
    "total_tokens": 1,
    "last_seen_at": 3
  },
  "duration_ms": 42,
  "errors": []
}
```

- `agents_scanned` — total agents inspected.
- `agents_updated` — how many agents had at least one column
  corrected.
- `counters_updated` — per-column tally of how many agents had
  that column corrected. Present only when non-empty.
- `duration_ms` — wall-clock time for the full scan.
- `errors` — per-agent failures (one string per failing agent).
  Empty on clean success.

### Status codes

| Code | Meaning |
|------|---------|
| 200  | Reconcile completed; `errors` is empty |
| 207  | Reconcile completed with per-agent errors (`errors` non-empty, otherwise identical shape) |
| 401  | Missing or invalid bearer token |
| 403  | Token valid but lacks admin scope |
| 409  | Another reconcile is already in progress (process-level mutex) |
| 500  | Fatal database error (pool exhausted, list query failure) |

### Concurrency

The endpoint serialises concurrent calls within a single API
replica via a `sync.Mutex.TryLock`. Multi-replica deployments
would require cross-process coordination; not solved pre-
emptively because the single-replica case is the v1 deployment
shape. A future revision can layer a Postgres advisory lock.

### Performance

O(n) in agent count. Each agent is two queries plus at most one
UPDATE. On the dev stack (~50 agents) a full scan completes in
30-50ms. At 10k agents expect ~5s — within a normal admin
request window, no pagination needed for v1.

### Concurrency with the worker

Reconcile is NOT atomic against concurrent worker writes. The
worker's `BumpAgentSessionCount` / `IncrementAgentTokens` execute
`SET col = col + N` as deltas; if a bump lands between our
`SELECT COUNT(*)` and `UPDATE SET`, the bump overshoots by that
delta and creates small drift the NEXT reconcile fixes. Bounded
by per-agent events-per-second during reconcile; admin invocation
is rare enough that residual drift converges over subsequent
calls. Invoke during quiet windows if strict-zero residual drift
matters.

### Example — dev stack

```bash
curl -s -X POST \
  -H 'Authorization: Bearer tok_admin_dev' \
  http://localhost:4000/api/v1/admin/reconcile-agents | jq
```

Expected output on a freshly-seeded dev stack: zero corrections
(the canonical fixtures are consistent). On a dev stack with
accumulated test-run drift, expect a non-zero
`counters_updated.total_sessions` and related.
