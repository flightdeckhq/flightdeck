# Scenario 1 End-to-End Smoke: Plugin Reconnect After Ingestion Outage

This note records a manual end-to-end verification of the scenario 1 flow
that D106 (server-side lazy session creation) and the commit 4a plugin
retry fix (removal of the disk-persisted unreachable flag) were designed
to handle together:

> Flightdeck control plane is unavailable when Claude Code starts. The
> plugin fires SessionStart and one or more events that all fail to
> reach the server. The stack recovers mid-session. The next plugin
> hook's events must land, lazy-create the session row, and render in
> the dashboard with tokens counted from the first post-recovery event
> onwards.

The test drives the real plugin CLI (`plugin/hooks/scripts/observe_cli.mjs`)
against the real dev stack with a crafted JSONL transcript and
Docker-controlled container toggles, so every layer is exercised with
the production code paths.

---

## Setup

Fresh dev stack (`make dev`). All containers running. One caveat about
which container to stop:

The plugin POSTs events to `$FLIGHTDECK_SERVER/ingest/v1/events`, which
nginx routes to `docker-ingestion-1` -- not to `docker-api-1`. Stopping
`docker-api-1` only breaks the dashboard read path (the `/api/*` routes);
events continue to land in Postgres through the `ingestion → NATS →
workers` write path unaffected. To actually simulate "plugin cannot
reach the server," the ingestion container has to be the one stopped.
This is called out here because prior smoke notes have referenced
`docker stop docker-api-1`; that does not exercise D106 via the plugin
path.

Test session id (UUIDv4): `396b0c9a-fe36-4ddd-9b2f-862a1ef97970`.

---

## Sequence and observed behaviour

### 1. Outage -- ingestion stopped, plugin Stop hook fired

```
$ docker stop docker-ingestion-1
# confirm nginx returns 504 on POST /ingest/v1/events
$ curl -s -o /dev/null -w "%{http_code}" -X POST \
    -H "Authorization: Bearer tok_dev" \
    -H "Content-Type: application/json" \
    -d '{}' http://localhost:4000/ingest/v1/events
504

# Run the plugin with a minimal one-turn transcript.
# The Stop hook fires ensureSessionStarted then flushPostCallTurns.
$ echo '{"hook_event_name":"Stop","session_id":"<sid>","transcript_path":"...transcript-1.jsonl"}' \
    | FLIGHTDECK_SERVER=http://localhost:4000 \
      FLIGHTDECK_TOKEN=tok_dev \
      FLIGHTDECK_CAPTURE_PROMPTS=false \
      node plugin/hooks/scripts/observe_cli.mjs
[flightdeck] cannot reach http://localhost:4000: 20. events dropped for this session.
[flightdeck] cannot reach http://localhost:4000: 20. events dropped for this session.
# exit 0
```

Exactly two "cannot reach" stderr lines, matching the bounded-stderr
contract from commit 4a: one per failed POST (SessionStart + post_call),
at most two per hook invocation. Hook exits 0 so Claude Code sees it
as healthy.

Plugin dedup markers inspected in `$TMPDIR/flightdeck-plugin/`:

- `started-<sid>.txt` -- ensureSessionStarted wrote it after POSTing
  SessionStart (the POST failed silently but the marker is written
  regardless, per the fire-and-forget design).
- `emitted-msg_smokeA_outage.txt` -- flushPostCallTurns marked the
  assistant turn locally before POSTing post_call. The POST failed but
  the marker persists, so a subsequent hook will not re-attempt this
  turn.

Database:

```sql
SELECT COUNT(*) FROM sessions WHERE session_id = '<sid>'::uuid;  -- 0
SELECT COUNT(*) FROM events   WHERE session_id = '<sid>'::uuid;  -- 0
```

Zero rows, as expected. Every POST failed at the network layer; nothing
reached the worker. The plugin has lost track of turn A from the
server's perspective, but its own bookkeeping says turn A is done.

### 2. Recovery -- ingestion restarted

```
$ docker start docker-ingestion-1
# wait until a malformed POST returns 400 (ingestion up, past startup):
$ curl -s -o /dev/null -w "%{http_code}" -X POST ... http://localhost:4000/ingest/v1/events
400
```

### 3. Post-recovery -- plugin Stop hook fired with extended transcript

The transcript is extended with a new assistant turn (different
`message.id`: `msg_smokeB_recovered`) reflecting new activity after
recovery. Running the same Stop hook against this transcript:

```
$ echo '{"hook_event_name":"Stop","session_id":"<sid>","transcript_path":".../transcript-2.jsonl"}' | \
    FLIGHTDECK_SERVER=http://localhost:4000 \
    FLIGHTDECK_TOKEN=tok_dev \
    FLIGHTDECK_CAPTURE_PROMPTS=false \
    node plugin/hooks/scripts/observe_cli.mjs
# no stderr, exit 0
```

Inside the plugin:

- `ensureSessionStarted` reads `started-<sid>.txt`, finds the marker,
  returns without re-sending SessionStart. The server will never see
  SessionStart for this session.
- `flushPostCallTurns` walks the two turns. Turn A's
  `markEmittedTurn(msg_smokeA_outage)` returns false (EEXIST); turn A
  is skipped entirely -- the server never gets turn A even though it
  never landed during the outage. This is the accepted outage-window
  loss (D106 records activity from the first post-recovery event, not
  retroactively).
- Turn B's `markEmittedTurn(msg_smokeB_recovered)` returns true. The
  plugin POSTs `post_call` with `tokens_input=300`, `tokens_output=75`,
  `tokens_total=375`, `model=claude-sonnet-4-6`.

Worker log (filtered by `session_id`):

```
INFO lazy-created session on event (D106) \
  session_id=396b0c9a-fe36-4ddd-9b2f-862a1ef97970 \
  event_type=post_call flavor=claude-code
```

`handleSessionGuard` saw the unknown session, called
`ReviveOrCreateSession`, which upserted the agents row and inserted
the sessions row with the event's payload fields.

### 4. Verification -- Postgres, worker logs, dashboard read APIs

Session row:

| Field | Value |
|-------|-------|
| session_id | `396b0c9a-fe36-4ddd-9b2f-862a1ef97970` |
| flavor | `claude-code` |
| agent_type | `developer` |
| state | `active` |
| tokens_used | `375` |
| started_at | `2026-04-18 14:05:01+00` (= event.occurred_at, backdated) |
| last_seen_at | `2026-04-18 17:55:02.422648+00` (worker ingest time) |
| context | `NULL` (the D106 "enrichable" sentinel; no session_start arrived) |

Events table: one row, `event_type=post_call`,
`tokens_total=375`, `model=claude-sonnet-4-6`, occurred_at matching
turn B's timestamp.

Dashboard read APIs (with api-1 healthy):

```
GET /api/v1/fleet → flavors[].sessions[] contains session with
  state=active, tokens_used=375
GET /api/v1/sessions/<sid> → session.state=active tokens_used=375
  flavor=claude-code events_count=1
```

### 5. Teardown

SessionEnd hook fired to close the smoke session so it doesn't linger
as `state=active` indefinitely:

```
state=closed tokens_used=375 ended_at=2026-04-18 17:55:48.380347+00
```

---

## Verdict

Scenario 1 behaviour is exactly as designed by D106 + commit 4a:

- Outage-window events are **lost** at the plugin (no queue by design,
  per fire-and-forget; D106 does not retroactively recover pre-recovery
  events).
- Post-recovery events **land** at the server and **lazy-create** the
  session row with best-effort identity.
- Dashboard surfaces the session immediately with correct token totals,
  counted from the first post-recovery event onwards.
- The plugin retries each hook fresh (no disk-persisted mute state,
  per commit 4a) so recovery happens without user intervention.

No code changes were needed to run this smoke; the implementation was
already correct. This note closes the end-to-end loop between:

- **D106 integration tests** (`tests/integration/test_session_states.py`)
  that exercise the worker's lazy-create path directly against the
  ingestion API, without the plugin.
- **Plugin unit tests** (`plugin/tests/observe_cli.test.mjs`) that
  exercise the retry behaviour against a local failing-server stub,
  without the real ingestion container.

The two prove the two halves in isolation; this note records the
observed behaviour when both halves meet in the real pipeline.

---

## Reproduction

```bash
# 1. Bring up a fresh dev stack.
make dev

# 2. Clear plugin markers and pick a fresh session id.
rm -rf /tmp/flightdeck-plugin
SID=$(uuidgen)
TMPD=$(mktemp -d)

# 3. Write a one-turn transcript.
cat > "$TMPD/transcript-1.jsonl" <<EOF
{"type":"user","timestamp":"2026-04-18T14:00:00Z","message":{"role":"user","content":"turn A"}}
{"type":"assistant","timestamp":"2026-04-18T14:00:01Z","message":{"id":"msg_smokeA_outage","model":"claude-sonnet-4-6","content":[{"type":"text","text":"turn A"}],"usage":{"input_tokens":100,"output_tokens":50}}}
EOF

# 4. Stop the ingestion container. Confirm POSTs get 504.
docker stop docker-ingestion-1

# 5. Fire the Stop hook; expect two "cannot reach" lines, exit 0.
echo "{\"hook_event_name\":\"Stop\",\"session_id\":\"$SID\",\"transcript_path\":\"$TMPD/transcript-1.jsonl\"}" \
  | FLIGHTDECK_SERVER=http://localhost:4000 \
    FLIGHTDECK_TOKEN=tok_dev \
    FLIGHTDECK_CAPTURE_PROMPTS=false \
    node plugin/hooks/scripts/observe_cli.mjs

# 6. Bring ingestion back.
docker start docker-ingestion-1

# 7. Extend the transcript with a new turn (different message.id).
cat > "$TMPD/transcript-2.jsonl" <<EOF
{"type":"user","timestamp":"2026-04-18T14:00:00Z","message":{"role":"user","content":"turn A"}}
{"type":"assistant","timestamp":"2026-04-18T14:00:01Z","message":{"id":"msg_smokeA_outage","model":"claude-sonnet-4-6","content":[{"type":"text","text":"turn A"}],"usage":{"input_tokens":100,"output_tokens":50}}}
{"type":"user","timestamp":"2026-04-18T14:05:00Z","message":{"role":"user","content":"turn B"}}
{"type":"assistant","timestamp":"2026-04-18T14:05:01Z","message":{"id":"msg_smokeB_recovered","model":"claude-sonnet-4-6","content":[{"type":"text","text":"turn B"}],"usage":{"input_tokens":300,"output_tokens":75}}}
EOF

# 8. Fire the Stop hook again; expect no stderr.
echo "{\"hook_event_name\":\"Stop\",\"session_id\":\"$SID\",\"transcript_path\":\"$TMPD/transcript-2.jsonl\"}" \
  | FLIGHTDECK_SERVER=http://localhost:4000 \
    FLIGHTDECK_TOKEN=tok_dev \
    FLIGHTDECK_CAPTURE_PROMPTS=false \
    node plugin/hooks/scripts/observe_cli.mjs

# 9. Verify: session row exists with tokens=375, state=active;
#    worker logs show "lazy-created session on event (D106)";
#    dashboard /api/v1/fleet includes the session.
docker exec docker-postgres-1 psql -U flightdeck -d flightdeck -c \
  "SELECT state, tokens_used FROM sessions WHERE session_id = '$SID'::uuid"
docker logs --since 2m docker-workers-1 2>&1 | grep -i "$SID\|lazy"
curl -s "http://localhost:4000/api/v1/sessions/$SID" \
  -H "Authorization: Bearer tok_dev"
```
