# Flightdeck Build Methodology

Flightdeck is built using a Supervisor/Executor methodology with Claude Code
as the Executor. This document describes how the methodology works and why
each rule exists.

---

## Two Roles

| Role | Responsibilities |
|------|-----------------|
| **Supervisor** (human) | Sets goals, reviews plans, approves architecture decisions, audits deliverables, resolves ambiguity |
| **Executor** (Claude Code) | Reads architecture docs, produces implementation plans, writes code, runs tests, reports discrepancies |

The Supervisor never writes code directly. The Executor never makes
architectural decisions. When the Executor encounters an ambiguous
requirement, it stops and asks rather than guessing.

---

## Planning Requirement

Every task follows the same sequence:

1. **Read** -- Executor reads ARCHITECTURE.md, DECISIONS.md, and CLAUDE.md
   in full before touching any file.
2. **Plan** -- Executor produces a written plan listing every file to create
   or modify, with a one-line rationale for each.
3. **Review** -- Supervisor reviews the plan, requests changes or approves.
4. **Implement** -- Executor writes code only after explicit approval.
5. **Verify** -- Executor runs all linters and tests, reports results.
6. **Report** -- Executor lists every file changed, every decision made,
   and any discrepancies found.

No code is written before step 3 completes. This prevents wasted work
and keeps the Supervisor aware of what will change before it changes.

---

## Audit Requirement

Before each phase closes, the Executor audits every file created during
that phase against ARCHITECTURE.md. The audit produces a discrepancy
table with four columns:

| File | Expected (ARCHITECTURE.md) | Actual | Status |

Status values: Aligned, Misaligned, Missing from code, Missing from docs.

The Supervisor reviews the table and directs fixes. The phase does not
close until all discrepancies are resolved.

---

## Living Document Rule

ARCHITECTURE.md is a living document, not a contract carved in stone.
When implementation reveals that a planned approach is wrong, impractical,
or superseded by a better idea:

1. Update ARCHITECTURE.md to reflect reality
2. Add a DECISIONS.md entry recording the pivot and why
3. Write the code
4. Tests pass
5. Report back

The order matters. Documentation is updated *before* code is merged, not
after. A codebase that contradicts its architecture document is worse than
no document at all.

---

## DECISIONS.md Discipline

Every significant decision is recorded in DECISIONS.md immediately --
before the code implementing it is written. Each entry follows the format:

- **Decision:** What was decided
- **Reasoning:** Why this approach was chosen
- **Rejected alternative:** What was considered and why it was rejected

When a decision is reversed, the reversal is recorded. Old entries are
never deleted. Future contributors must be able to read the decision log
and understand why the code looks the way it does.

---

## External Memory

The Supervisor maintains context across sessions through three documents:

- **ARCHITECTURE.md** -- The single source of truth for what the system
  does and how it is structured
- **DECISIONS.md** -- Why it is built this way and what alternatives
  were rejected
- **CLAUDE.md** -- Standing rules for every Claude Code session

These documents are read at the start of every session. They replace
the need for the Executor to "remember" prior conversations.

---

## Lessons

These six lessons distill the durable guidance from past V-pass
reviews. Phrased as standing rules: they apply to every PR, not
to a particular phase.

### L1 — Docs are contemporary descriptions

ARCHITECTURE describes what the system IS, not how it got there.
Phase tags, "was added," "previously," and similar temporal
qualifiers do not belong in ARCHITECTURE. Change history lives in
CHANGELOG and `git log`. A reader with zero project history must be
able to learn the system as it stands today from the architecture
doc alone, with no narrative thread of "first we did X, then we
moved to Y."

### L2 — Docs update in the same PR as the code

Every PR that changes a runtime behaviour ARCHITECTURE describes,
or that introduces a decision DECISIONS.md should record, updates
those docs in the same PR. Drift accumulates when docs lag —
a codebase that contradicts its architecture document is worse
than no document. The order is doc-first: update ARCHITECTURE.md
→ record the decision in DECISIONS.md → write the code → run
tests → report.

### L3 — Dead-end UX is a bug class

Anywhere a user can see something but cannot act on it — an agent
without accessible sessions, an error without details, a list
without pagination, a detail panel that opens onto an empty state
— is a bug, even if technically functional. UI surfaces that show
the existence of data but block all paths to that data have failed
their job. Treat dead-ends as defects, not polish.

### L4 — V-pass requires end-to-end behaviour verification

Verify by tracing the data flow, not by reading the code. A
feature declared in code that has no emission path from sensor
through pipeline through storage through surface is a silent
failure: tests with mocks pass, the dashboard shows nothing, no
alarm fires. Before declaring a feature shipped, exercise it
against the live dev stack and confirm the value lands at the
surface a user touches.

### L5 — Modality content-capture parity

Every communication modality with a request/response payload
supports content capture, gated by `capture_prompts` (or a
modality-specific flag where the modality has different
sensitivity). Adding a new modality (chat, embeddings, completions,
tool-call results, anything future) without content capture ships
a documented gap by default. Audit new modality work for capture
parity before merging.

### L6 — Severity follows deployment surface AND threat-model trace

A finding's severity is not a property of the code shape — it's a
function of where the code runs (production / dev-tooling /
test-only) and what an explicit threat-model trace says about
attack vector, protecting invariants, and realistic impact. The
same SQL-injection-shaped pattern is critical in a production
handler and low in a dev seed script. "Looks dangerous" is not
the same as "is dangerous." Every HIGH or CRITICAL needs the
trace recorded in the PR; pattern-matching on shape alone produces
false alarms that crowd out real issues.

### L7 — Patch the protocol contract, not the framework adapter

When a protocol or wire layer is mediated by multiple framework
adapters (Phase 5: MCP via langchain-mcp-adapters, langgraph,
llama-index-tools-mcp, mcpadapt, plus the raw `mcp` SDK), patch
the protocol's canonical client class — not each adapter. The
adapters share one upstream and drift independently; one patch
surface against the upstream covers them all and tracks one
release cadence instead of N. Framework attribution lives on the
existing per-event `framework` field, not on the patched layer.

Applied first in Phase 5 with `ClientSession`-level patching for
MCP (D117). The same principle applies to any future protocol
that grows multi-framework adoption (a hypothetical
agent-to-agent transport, structured tool schemas, etc.) — find
the single contract every adapter shares and patch there.

### L8 — Surface failures on the row, not only inside the event

Phase 5's MCP event family ships in three colour families
(cyan/green/purple) regardless of success vs. failure. Pre-fix,
an operator scanning the session-drawer event feed could not
distinguish a successful `mcp_tool_call` from a failed one
without expanding the row to read MCPEventDetails. The fix
(MCPErrorIndicator: small inline AlertCircle when
`payload.error` is populated) restores parity with the
Investigate session-row dot used for `llm_error`.

The lesson: any new event shape that has both success and
failure variants needs a row-level visual cue. The existing
patterns in the codebase (per-row error dot on the listing,
`directive_result` colour override on the swimlane) work
because they're self-evident from a glance — applying them to
new event types is mandatory before merge, not a polish
follow-up.
