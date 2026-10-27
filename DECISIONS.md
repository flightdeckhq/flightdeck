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
