# Known Issues and Deferred Concerns

This file is the index of all deferred architectural concerns. The authoritative
location for each issue is the TODO comment in the code itself. This file provides
a phase-by-phase summary view.

Claude Code: at the start of every phase, run:

```bash
grep -rn "TODO(KI" . \
  --include="*.go" \
  --include="*.py" \
  --include="*.ts" \
  --include="*.yml" \
  | grep "\[Phase N\]"
```

Replace N with the current phase number. Every result must be included in the
phase plan before any feature work begins. When an item is resolved, remove its
TODO comment from the code, move it to the Resolved table below, and record the
fix in DECISIONS.md. Never leave a resolved TODO comment in the code.

---

## Open

| ID   | Component  | Concern                              | Risk   | Phase | File                                        | DECISIONS |
|------|------------|--------------------------------------|--------|-------|---------------------------------------------|-----------|
| KI01 | Sensor     | PolicyCache empty on first call      | Medium | 2     | core/session.py:Session.start               | D040      |
| KI02 | Ingestion  | NATS event loss on unavailability    | Medium | 2     | nats/publisher.go:Publish                   | D041      |
| KI03 | Ingestion  | Token validation not cached          | Low    | 2     | auth/token.go:Validate                      | D048      |
| KI04 | Ingestion  | No rate limiting                     | Low    | 2     | handlers/events.go:EventsHandler            | D048      |
| KI05 | Workers    | No state transition guards           | Medium | 2     | processor/session.go:HandleSessionStart     | D042      |
| KI06 | Workers    | Per-event policy Postgres query      | Medium | 2     | processor/policy.go:Evaluate                | D043      |
| KI07 | API        | GET /v1/fleet no pagination          | Medium | 2     | handlers/fleet.go:FleetHandler              | D045      |
| KI08 | API        | WebSocket broadcast fan-out          | Medium | 2     | ws/hub.go:Broadcast                         | D044      |
| KI09 | Sensor     | SIGKILL phantom session state        | Medium | 3     | core/session.py:_register_handlers          | D039      |
| KI10 | Security   | SHA256 token auth without salt       | Low    | 5     | auth/token.go:Validate                      | D046      |
| KI11 | Security   | No NATS auth in dev compose          | Low    | 5     | docker/docker-compose.yml:nats              | D047      |

## Resolved

| ID    | Component  | Concern                              | Resolved in | DECISIONS |
|-------|------------|--------------------------------------|-------------|-----------|
| KI-R1 | Sensor     | Hot path blocking on event POST      | Phase 1     | D037      |
| KI-R2 | API        | LISTEN connection no reconnect       | Phase 1     | D038      |
| KI-R3 | Ingestion  | Kill switch not delivered to idle     | Phase 1     | D049      |
