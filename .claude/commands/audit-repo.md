---
description: Comprehensive whole-repo audit using all reviewer agents, gated approval before any fixes.
argument-hint: [optional path or glob, defaults to entire repo]
---

You are running a full repository audit, not a per-turn review. Your job is to coordinate the specialist reviewer agents, produce one comprehensive report, and stop for explicit approval before any fix is applied.

## Scope

Target: `$ARGUMENTS`. If empty, audit the entire repo from the current working directory.

## Step 1: Inventory the repo

Use Glob and Grep to identify what is present. Do not load file contents yet, just structure:

- Languages: count of `*.py`, `*.go`, `*.ts`, `*.tsx`, `*.js`, `*.jsx`, `*.css`, `*.scss`, others
- Architecture artifacts: anything under `docs/architecture/`, `docs/adr/`, `architecture/`, plus top-level `ARCHITECTURE.md`, `SYSTEM.md`, any `*-design.md`
- Test infrastructure: `pytest.ini`, `pyproject.toml` test config, `go.mod` with `_test.go` files, `jest.config.*`, `vitest.config.*`, `playwright.config.*`, `cypress.config.*`
- Project rules: `CLAUDE.md`, `CONTRIBUTING.md`, `.editorconfig`, lint configs
- Security artifacts: `Dockerfile`, `docker-compose*.yml`, dependency manifests (`package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`, `requirements*.txt`, `Pipfile`), lockfiles, CI workflow files (`.github/workflows/`, `.gitlab-ci.yml`, `.circleci/`), `SECURITY.md`, security tool configs (`.gitleaks.toml`, `.semgrep.yml`, `.bandit`)

Print a one-paragraph inventory summary before continuing.

## Step 2: Decide which agents to run

Always include:
- `@architect` for any non-trivial repo
- `@doc-expert` for any repo with developer-facing docs (essentially always)
- `@qa-engineer` for any repo with tests or testable code
- `@security-reviewer` for any repo with code, dependency manifests, Dockerfiles, or CI workflows. The agent bails politely with CLEAN if nothing security-relevant turns up.

Conditionally include:
- `@python-principal` if any `.py` files exist in scope
- `@go-principal` if any `.go` files exist in scope
- `@ts-principal` if any `.ts`, `.tsx`, `.js`, `.jsx`, `.css`, or `.scss` files exist in scope

State which agents will run and why before invoking them.

## Step 3: Invoke selected agents in parallel

Run all selected agents concurrently. To each one, pass this explicit instruction at invocation:

> Full-repo audit mode. Do NOT use `git diff` to scope your review. Review every relevant file under the target path (`$ARGUMENTS` if non-empty, otherwise the whole repo). Apply your guidelines file exhaustively. If the scope is large, batch your reads in groups of 20 to 30 files and keep going until you have covered everything. Produce your standard structured report at the end, with file:line references for every finding.

Wait for every agent to complete before moving on.

## Step 4: Synthesize one comprehensive report

Produce the report in this exact structure:

```
# Repository Audit Report

## Repo summary
- Path audited: <path>
- Languages: <list with file counts>
- Architecture docs found: <list or "none">
- Test framework(s): <list or "none">
- Reviewers run: <list>

## Critical findings (must fix)

### Python (from @python-principal)
- <file:line> — <issue> — <suggested fix>

### Go (from @go-principal)
- <file:line> — <issue> — <suggested fix>

### Frontend (from @ts-principal)
- <file:line> — <issue> — <suggested fix>

### Architecture (from @architect)
- Drift: doc says <X at file:line>, code does <Y at file:line>. Recommendation: <doc / code / ADR>
- <other critical concerns>

### QA (from @qa-engineer)
- Failing tests: <list>
- Missing critical tests: <list with file location and what to assert>

### Security (from @security-reviewer)
- <file:line> — <issue> — <category from guidelines> — <suggested fix>

## Warnings (should fix)
Same grouping as above.

## Suggestions (nice to have)
Same grouping as above.

## Doc updates needed
- <file> — <what to update>

## UI verification plan
<the QA agent's numbered checklist if applicable, otherwise omit>

## Aggregate verdicts
- python-principal: <CLEAN / DIRTY>
- go-principal: <CLEAN / DIRTY>
- ts-principal: <CLEAN / DIRTY>
- architect: <CLEAN / DIRTY>
- qa-engineer: <CLEAN / DIRTY>
- security-reviewer: <CLEAN / DIRTY>
- doc-expert: <CLEAN / DIRTY>

## Estimated fix scope
- Auto-fixable by @code-fixer: <count of items>
- Needs human decision: <count of items>
```

Do not modify any file during this step.

## Step 5: Stop and ask for explicit approval

Present the report, then stop and ask exactly this:

> The audit is complete. How should I proceed?
> - `all` — apply every safe fix from the @code-fixer's allowed list, across all critical and warning findings
> - `critical` — apply only fixes for critical findings
> - `select` — I will list specific items by number or section
> - `no` — stop, do not modify anything

Wait for the user's response. Do not infer intent. Do not start fixing anything until the user has answered.

## Step 6: Apply fixes only after explicit approval

If the user answers `no`, end the turn after confirming nothing was changed.

If the user answers `all`, `critical`, or `select`, invoke `@code-fixer` once with the approved subset of findings as input. The fixer will apply only items that fit its safe-list and will skip ambiguous cases with reasons.

After `@code-fixer` finishes, the Stop hook will fire on the next turn boundary and re-run the relevant reviewers (scoped to `git diff`, which will be exactly the fixes). This verifies that fixes did not introduce regressions.

## Notes for the user (include in the final summary)

- Whole-repo audits are expensive on large codebases. If the repo has more than roughly 200 files in a language, consider running `/audit-repo <path>` to scope.
- The audit itself never modifies files. Only Step 6, after your explicit approval, does.
- Findings the fixer skips will be listed in its output as "needs human review". Address those manually in a follow-up.
