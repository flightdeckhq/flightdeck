# Architecture review guidelines

## Where architecture artifacts live
- System design docs: top-level `ARCHITECTURE.md`, `SYSTEM.md`, `docs/architecture/`, `architecture/`, or any `*-design.md`.
- Decision records: `DECISIONS.md` at the repo root (Flightdeck convention), or `docs/adr/` / `docs/architecture/decisions/` / `architecture/decisions/` for ADR-numbered records.
- Sequence and component diagrams: same locations, typically `.md` with mermaid or `.drawio` / `.png`.

## Hard rules

- Living architecture docs describe what the system IS, not how it got there. No phase tags, no "Phase 3 added X", no "previously did Y". That history belongs in `CHANGELOG.md`, `DECISIONS.md` (or ADRs), and commit/PR bodies.
- Every documented behavior matches running code. Drift between docs and code is a critical finding. The fix is either (a) update the doc, (b) change the code, or (c) record a decision in `DECISIONS.md` / a new ADR — never silent divergence.
- Every significant pivot is recorded in `DECISIONS.md` (or an ADR) before code lands. What was planned, what changed, why, what was rejected.
- D-numbered / ADR-numbered references are acceptable in living docs when they explain why a system is shaped a particular way. Phase tags are not.
- Domain layer has no imports from infrastructure (db, http, framework SDKs). Application layer orchestrates, doesn't contain business rules. No circular dependencies between modules or services.
- Public API surface is intentional, not accidental. Backward-incompatible changes get a deprecation path and a version bump; additive changes only on stable APIs.
- Every model call has a timeout, retry policy, and a fallback (cheaper model, cached response, or graceful failure). Prompts are versioned. Model IDs and parameters are configurable, not hardcoded in business logic.

## Idiomatic patterns

### API and contract design
- Versioning strategy is consistent (URL, header, or media type — pick one).
- Error responses follow a documented schema.
- Idempotency keys on any non-GET endpoint that could be retried.

### Distributed systems
- At-least-once vs exactly-once tradeoffs are explicit.
- Retries have backoff, jitter, and a budget.
- Circuit breakers or bulkheads on synchronous external calls.
- Timeouts everywhere, with values that compose (caller timeout > callee timeout + buffer).
- Idempotency for any operation that mutates state and might be retried.
- Ordering guarantees stated and enforced (or stated and not relied upon).
- Saga or outbox patterns for cross-service consistency, not distributed transactions.

### Data
- Schema migrations are forward-only and backward-compatible during deploy windows.
- Sensitive data is identified and the path through the system is documented (PII, secrets, regulated data).
- Read and write paths are separable enough to scale independently if needed.

### Observability
- Structured logs with consistent fields (`request_id`, `user_id`, `session_id`, `span_id`).
- Metrics: RED for request services (Rate, Errors, Duration), USE for resources (Utilization, Saturation, Errors).
- Distributed tracing across service boundaries.
- Correlation IDs propagated through async hops (queues, scheduled jobs).
- Dashboards and alerts exist for new components, not just for old ones.

### Security posture (architectural)
- Defense in depth: don't rely on one layer.
- Principle of least privilege on credentials, IAM, db roles.
- Authn separate from authz, both explicit.
- Threat model exists for new external surfaces.
- Secrets rotation and revocation are possible without redeploy.

### AI and ML systems
- Prompts are versioned and stored as data, not buried in code strings.
- Model identifiers and parameters are configurable, not hardcoded.
- Eval harness exists for prompt and model changes, with regression baselines.
- For RAG: retrieval quality is measured (recall@k, precision@k on a labelled set), not assumed; chunking strategy is documented; embedding model version is pinned.
- Guardrails for output: schema validation, content filtering, refusal handling.
- Prompt injection defense for any user-controlled text reaching the model.
- Cost and latency budgets per call, monitored.
- PII handling: what reaches the model, what gets logged, what gets stored.

## Banned patterns

- Phase tags or "as of phase N" prose anywhere in living architecture docs.
- Diagrams that disagree with the code without a flagged caveat.
- New endpoints added without an authz policy.
- Synchronous external calls without timeout, retry, or circuit breaker.
- Schema migrations that aren't backward-compatible during deploy windows.
- Model identifiers / parameters hardcoded in business logic (configure them).
- `eval`-style execution of model-emitted text without a strict allowlist or human-in-the-loop.
- Decisions made silently — every pivot belongs in `DECISIONS.md` (or an ADR) before merge.

## Project-specific notes

Flightdeck conventions (see `CLAUDE.md` rules 33, 41–45):

- **Wire contract (rule 33).** The event payload schema is the contract between
  flightdeck-sensor and the ingestion API. Never change the payload schema
  without updating `ARCHITECTURE.md` first. The order is always: update
  `ARCHITECTURE.md` → record the pivot in `DECISIONS.md` (with what was
  planned, what changed, why, what was rejected) → write the code → tests
  pass. Code that contradicts the documented contract is wrong, not the
  contract.
- **Living docs (rules 41–45).** `ARCHITECTURE.md` describes the system as it
  stands today. No phase tags. No "was added in Phase X". No "previously did
  Y". That history lives in `CHANGELOG.md`, `DECISIONS.md`, and PR/commit
  bodies. D-numbers (e.g. `D094`, `D126`, `D148`) ARE allowed in
  `ARCHITECTURE.md` when they explain why the system is shaped a particular
  way — they point at durable `DECISIONS.md` entries. The 51-rule
  methodology in `CLAUDE.md` is the source of truth for review discipline.
- **Drift surfaces.** Flightdeck has three contract surfaces where drift is
  most likely to bite: (a) sensor event payload vs ingestion validator,
  (b) `GET /v1/analytics` `metric` / `group_by` enums (rules 25–26) vs the
  store layer, (c) MCP policy schema vs the policy resolver. Flag any drift
  here as Critical, not Warning.
