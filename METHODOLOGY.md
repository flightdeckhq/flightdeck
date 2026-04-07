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
