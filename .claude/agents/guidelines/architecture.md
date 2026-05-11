# Architecture review guidelines

## Where architecture artifacts live
- ADRs (Architecture Decision Records): `docs/adr/`, `docs/architecture/decisions/`, or `architecture/decisions/`
- System design docs: `docs/architecture/`, `architecture/`, top-level `ARCHITECTURE.md`, `SYSTEM.md`, or `*-design.md`
- Sequence and component diagrams: same locations, often `.md` with mermaid or `.drawio` / `.png`

## What I look for

### Drift between docs and code
- A doc claims a service has property X (idempotent, retries, async, etc) and the code does not
- A diagram shows a component or boundary that no longer exists, or misses one that does
- An ADR was superseded but the code still follows the old decision (or vice versa)

### Layering and dependencies
- Domain layer has no imports from infrastructure (db, http, frameworks)
- Application layer orchestrates, doesn't contain business rules
- No circular dependencies between modules or services
- Public API surface is intentional, not accidental

### API and contract design
- Backward compatibility: additive changes only on stable APIs, deprecation path for removals
- Versioning strategy is consistent (URL, header, or media type, pick one)
- Error responses follow a documented schema
- Idempotency keys on any non-GET endpoint that could be retried

### Distributed systems concerns
- At-least-once vs exactly-once tradeoffs are explicit
- Retries have backoff, jitter, and a budget
- Circuit breakers or bulkheads on synchronous external calls
- Timeouts everywhere, with values that compose (caller timeout > callee timeout + buffer)
- Idempotency for any operation that mutates state and might be retried
- Ordering guarantees stated and enforced (or stated and not relied upon)
- Saga or outbox patterns for cross-service consistency, not distributed transactions

### Data
- Schema migrations are forward-only and backward-compatible during deploy windows
- Sensitive data is identified and the path through the system is documented (PII, secrets, regulated data)
- Read and write paths are separable enough to scale independently if needed

### Observability
- Structured logs with consistent fields (request_id, user_id, span_id)
- Metrics: RED for request services (Rate, Errors, Duration), USE for resources (Utilization, Saturation, Errors)
- Distributed tracing across service boundaries
- Correlation IDs propagated through async hops (queues, scheduled jobs)
- Dashboards and alerts exist for new components, not just for old ones

### Security
- Defense in depth: don't rely on one layer
- Principle of least privilege on credentials, IAM, db roles
- Authn separate from authz, both are explicit
- Threat model exists for new external surfaces
- Secrets rotation and revocation is possible without redeploy

### AI and ML systems specifically
- Prompts are versioned and stored as data, not buried in code strings
- Model identifiers and parameters are configurable, not hardcoded
- Every model call has a timeout, retry policy, and a fallback (cheaper model, cached response, or graceful failure)
- Eval harness exists for prompt and model changes, with regression baselines
- For RAG: retrieval quality is measured (recall@k, precision@k on a labelled set), not assumed; chunking strategy is documented; embedding model version is pinned
- Guardrails for output: schema validation, content filtering, refusal handling
- Prompt injection defense for any user-controlled text reaching the model
- Cost and latency budgets per call, monitored
- Hallucination mitigation: retrieval grounding, citations, or constrained outputs where possible
- PII handling: what reaches the model, what gets logged, what gets stored

## Review output
For drift specifically, always state both sides:
- Doc says: <quote or paraphrase>, location: <file:line>
- Code does: <description>, location: <file:line>
- Recommendation: update doc OR change code OR file an ADR

## Project-specific notes
<!-- Add per-project rules here. -->
