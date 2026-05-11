# Documentation guidelines

## Hard rules

- README first. A new engineer should clone, read README.md, and have one runnable command within five minutes. If they cannot, the README is wrong.
- Every code repository has at minimum: `README.md`, `LICENSE`, and a `CHANGELOG.md` once any release exists. Public open-source repos additionally have `CONTRIBUTING.md`, `SECURITY.md`, and `CODE_OF_CONDUCT.md`.
- Every doc has a clear audience. Decide who you are writing for and write only for them. README is for users. CONTRIBUTING is for would-be committers. ADRs are for future maintainers. Don't blend audiences in one file.
- Every document is dated or versioned where time-sensitive. A doc that says "we recently shipped X" without a date or version is bait for confusion.
- No broken links. CI link-checks the docs directory.
- No copy-paste-broken code blocks. Every code block in docs is either runnable as written or marked `# pseudocode`.
- Doc changes ship with the code change that justifies them. Never separate "the code change" PR from "the doc update" PR. Reviewers verify both together.
- Living docs (ARCHITECTURE.md, system design docs) describe what the system IS, not how it got there. No phase tags, no "in the previous version", no "we used to do X". That history belongs in CHANGELOG, ADRs, or commit history.

## README structure

A good README answers, in this order:

1. What is this project. One sentence at the top, then a paragraph. No marketing fluff.
2. Status badges. Build, test, version, license. Keep the set small enough to scan.
3. Why does it exist. The problem it solves and who has that problem.
4. Quick start. Three commands or fewer to a working demo on a fresh machine. State prerequisites explicitly (Go version, Node version, Docker, etc.).
5. How to install for real use (not just demo).
6. How to use. Minimum viable usage example, fully runnable.
7. How to develop. Pointer to CONTRIBUTING.md or an inline section for small projects.
8. Where to learn more. Links to deeper docs, ADRs, dashboards, runbooks.
9. License. One line.

Anti-patterns:
- A README that requires reading three other documents before any command works.
- A README whose Quick Start fails on a clean machine because of an undocumented prerequisite.
- A README that is mostly a logo and a tagline.

## CHANGELOG.md

- Follow [Keep a Changelog](https://keepachangelog.com/) format. The structure (Added / Changed / Deprecated / Removed / Fixed / Security) is non-negotiable.
- Use semver: MAJOR.MINOR.PATCH. Pre-1.0 software ships breaking changes in MINOR; 1.0 onward ships breaking changes only in MAJOR.
- Every release has a date.
- Every entry is one line, user-facing language, no implementation noise. "Add X feature" not "Refactor handler.go to support X".
- Link to the version diff at the top of each release section if the project is on GitHub or GitLab.
- Unreleased section at the top accumulates between releases. Empty it on release.

Anti-patterns:
- A CHANGELOG that is a copy of `git log --oneline`.
- A CHANGELOG with no dates.
- A CHANGELOG that stops being updated three releases in.

## CONTRIBUTING.md

Tells a contributor how to make their first PR succeed. Cover:

- How to set up the dev environment (link to README's dev section if duplicate).
- How to run the test suite.
- The commit message convention (conventional commits, etc.).
- How to file a bug report (link to issue templates).
- How to propose a feature (link to issue templates or a discussions board).
- The review process: who reviews, how long it usually takes, what blocks merge.
- The code style (link to the linter config, not a re-explanation of it).
- The DCO or CLA if one exists.

Anti-patterns:
- A CONTRIBUTING.md that says "see the wiki" with no link.
- A CONTRIBUTING.md that lists style rules manually instead of pointing to the lint config (which the lint runs anyway).

## SECURITY.md

- How to report a vulnerability. A specific email, signal channel, or a private security advisory link. Not "open an issue".
- The expected response time.
- The supported versions matrix.
- The disclosure timeline (e.g. coordinated disclosure 90 days).
- Optionally a PGP key.

## ADRs (Architecture Decision Records)

- Live in `docs/adr/`, `docs/architecture/decisions/`, or `architecture/decisions/`. Pick one per project.
- Numbered: `0001-record-architecture-decisions.md`, `0002-use-postgres.md`, etc.
- One ADR per decision. Don't combine.
- Format: Title, Status (Proposed / Accepted / Deprecated / Superseded by NNNN), Context, Decision, Consequences. Optionally Alternatives.
- An ADR is immutable once Accepted. To change a decision, write a new ADR that supersedes the old one. Mark the old one Superseded.
- Decisions worth an ADR: choosing a database, picking a queue, defining a service boundary, picking an authn strategy, adopting or rejecting a framework. Day-to-day code decisions (variable names, function signatures) are not ADRs.

## Living architecture docs (ARCHITECTURE.md, SYSTEM.md, *-design.md)

- Describe the current state. A new engineer should be able to read it and learn the system as it stands today, with no prior history.
- Sections: layers, components, contracts, data flows, invariants, observability, deployment topology.
- No phase tags, no "Phase 3 added X". That belongs in CHANGELOG and ADRs.
- D-numbered or ADR-numbered references are acceptable when they explain why a system is shaped a particular way (durable references that point to the decision record).
- Diagrams: prefer mermaid checked-in alongside the .md so they render in the browser. PNG is acceptable but provide the source.
- Update with every PR that changes the documented surface. A code-doc drift is a methodology violation, not a backlog item.

## API documentation

- For HTTP APIs: OpenAPI / Swagger. Generated from the code, not hand-written. CI verifies the spec is up to date.
- Every endpoint documents: summary, description, request schema, response schemas (per status code), error codes, auth requirements.
- Examples are runnable curls or SDK snippets that work against a documented base URL.
- Backward-incompatible changes get a major version bump and a deprecation period.

## Code comments

- Comments explain why, not what. The code already says what.
- A comment above a non-obvious workaround names the issue, the link to the bug or thread, and the date.
- TODO comments name an owner and a tracking link: `// TODO(omri, INGEST-413): batch this once the queue contract is finalized`. Anonymous TODOs rot.
- Doc comments on exported identifiers (Python docstrings, Go doc comments) follow the language's convention. They are not optional on public APIs.
- Don't comment-out code. Delete it. Git remembers.

## Examples and tutorials

- Every example must work as written, on a clean machine, against the version it claims to support.
- Pin versions explicitly in the example (`go 1.23`, `python 3.12`, `node 20`).
- Run the examples in CI on the documented platforms.
- Date the example or pin it to a release tag if the underlying code moves fast.

## Diagrams

- Source-controlled. Mermaid in `.md` files is preferred because it renders inline.
- For tools that need a binary format (drawio, lucid, etc.), check in both the source file (`.drawio`) and a rendered export (`.png`, `.svg`).
- Every diagram has a one-line caption stating what it shows. A diagram without a caption is decorative.
- Keep diagrams minimal. A diagram with 40 boxes communicates nothing. Split or summarize.

## Anti-patterns to flag

- A docs/ folder that is a graveyard of half-written design notes from past quarters.
- "TODO: write this section later" left in a published doc.
- A README badge for a service that has been dead for two years.
- Time-sensitive copy ("currently we use", "as of last quarter") in a stable doc.
- A document that contradicts the code without flagging the discrepancy.
- A document with no clear owner. (Living docs need owners; orphaned docs become wrong.)
- Generated docs committed without the source-of-truth that generated them.

## How I report

```
## Documentation review summary
- Files reviewed: <list>
- Project docs structure: <pass / has gaps / disorganized>

## Critical (must fix)
- <file:line> — <issue> — <how to fix>

## Warnings (should fix)
- ...

## Suggestions (nice to have)
- ...

## Doc updates needed (drift between code and docs)
- <doc file>: says <X>, code does <Y>. Recommendation: <update doc / change code>.

## Verdict
- CLEAN if no critical and no warnings.
- DIRTY otherwise.
```

## Project-specific notes

<!-- Add per-project rules here. -->
