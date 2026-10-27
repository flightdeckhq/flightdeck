# Flightdeck Decisions

The decisions a future contributor needs before changing the system:
why a contract, a schema or a trust boundary is shaped the way it is,
and which alternative was rejected so nobody proposes it again.

Record a decision here when it:

- changes a contract: the event payload, an API request or response,
  a wire or file format;
- changes the database schema;
- moves a trust or security boundary (authentication, what is stored,
  what crosses a network); or
- rejects an alternative a future contributor would plausibly propose
  again.

Everything else (implementation choices, plan changes, review notes,
bug write-ups) goes in the PR description and commit body, where `git
log` keeps it next to the change.

Each entry is 10 to 15 lines:

```
## D214 -- <the decision, as a sentence>

**Date:** YYYY-MM-DD
**Decision:** what the system does.
**Why:** the constraint or evidence that made it the right call.
**Rejected alternative:** what was considered and why it lost.
```

Decisions D001 to D213 are in [DECISIONS-ARCHIVE.md](DECISIONS-ARCHIVE.md),
frozen on 2026-10-27; D-numbers cited in CHANGELOG.md, migrations and
PR history resolve there. Numbering continues from D214. A new entry
that supersedes an archived one says so in its **Decision** line.

## D214 -- client_type is a registry of nine values with per-type defaults

**Date:** 2026-10-27
**Decision:** `client_type` accepts `claude_code`, `flightdeck_sensor`, `claude_agent_sdk`, `codex`, `copilot`, `opencode`, `gemini_cli`, `cursor` and `otlp`, all registered now although most have no emitter yet. Each value carries a label and defaults for `context.supports_directives` and `billing_mode`. `contracts/client_types.json` is the source; ingestion, the API, the worker, the cost query, the dashboard and the two Postgres `CHECK` constraints keep literal copies, each pinned to it by a parity test. `agent_type` stays independent of `client_type`.
**Why:** the Agent SDK interceptor, five coding-agent adapters and the OTLP receiver each need their own value, and the two hard-coded values sat in five places, so every adapter would have meant a migration and five edits. Registering the full list costs one migration (the user chose this).
**Rejected alternative:** reusing `flightdeck_sensor` and telling sources apart by `framework` (every query and default would branch on `framework`); adding each value with its adapter (a migration and five edits per adapter); generating the copies from the JSON at build time (the Go services build from their own module directory and cannot read it; parity tests give the same guarantee).

