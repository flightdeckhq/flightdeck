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
**Decision:** `client_type` accepts nine values (ARCHITECTURE, "Client
type registry"), registered before most have an emitter, each with a
label, an expected `agent_type` and defaults for `supports_directives`,
`billing_mode` and tool-error redaction. `contracts/client_types.json`
is the source; parity tests pin every copy. Supersedes D166's flags and
D167's "not described until shipped" clause; narrows D109's Claude Code
fallback to rows with no `client_type`.
**Why:** each integration needs its own value, and the literal sat in a
dozen places; one migration for all nine beats one per integration.
**Rejected alternative:** reusing `flightdeck_sensor` with `framework`
(every query would branch on it); a value per integration as it lands;
a `client_types` reference table (ingestion, the worker and the
dashboard need the defaults too, so it would be one more copy).
