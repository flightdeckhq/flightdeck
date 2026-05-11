# Flightdeck review pipeline

This directory ships the project's automated code-review pipeline.
Claude Code auto-loads everything here when you open the repo, so
every contributor inherits the same agents, guidelines, audit
command, and Stop hook with no setup.

## What's here

```
.claude/
├── agents/
│   ├── architect.md            Distinguished Architect — drift, layering,
│   │                           distributed-systems and AI/ML concerns
│   ├── code-fixer.md           Applies safe mechanical fixes from any
│   │                           reviewer report; skips ambiguous changes
│   ├── doc-expert.md           Technical Documentation Expert — README,
│   │                           CONTRIBUTING, CHANGELOG, SECURITY, /docs
│   ├── go-principal.md         Principal Go Engineer — idiomatic Go,
│   │                           error handling, concurrency
│   ├── python-principal.md     Principal Python Engineer — idioms,
│   │                           hot-path / async / capture posture
│   ├── qa-engineer.md          QA Automation Engineer — coverage,
│   │                           polling vs sleep, UI verification plan
│   ├── security-reviewer.md    Principal Security Engineer — 16
│   │                           categories, capture posture, MCP policy
│   ├── ts-principal.md         Principal TS/React Engineer — theme
│   │                           parity, accessibility, shadcn/ui only
│   └── guidelines/
│       ├── architecture.md     Drift, distributed systems, AI/ML rules
│       ├── docs.md             README/CHANGELOG/CONTRIBUTING/ADR rules
│       ├── golang.md           Go idioms, errors, concurrency, testing
│       ├── python.md           Python idioms, async, security, testing
│       ├── qa.md               Polling helpers, test pyramid, flakiness
│       ├── security.md         16 categories: authn/z → capture → TOCTOU
│       └── typescript.md       TS strict mode, React hooks, theme tokens
├── commands/
│   └── audit-repo.md           /audit-repo — whole-repo audit with all
│                               reviewers, gated approval before fixes
├── settings.json               Stop hook routing (this file)
└── settings.local.json         (gitignored — your personal permissions)
```

The 7 reviewers + 1 fixer cover Flightdeck's full surface: Go
ingestion + workers + api, Python sensor + tests, TypeScript
dashboard, architecture, documentation, security posture, and QA.

## How to invoke an agent

Two paths, both routed by Claude Code:

1. **Explicit `Task` call.** From inside a Claude Code session, ask
   the assistant to spawn a reviewer: "run @go-principal on this
   diff" or "have @security-reviewer audit the new auth handler".
   The assistant uses the `Task` tool with `subagent_type` set to
   the agent name.
2. **`/audit-repo` slash command.** Run `/audit-repo` (or
   `/audit-repo path/glob`) for a whole-repo audit. The command
   inventories the repo, decides which specialists to invoke,
   runs them in parallel, synthesizes one report, and stops for
   explicit approval before applying any fix.

## How the Stop hook routes

`.claude/settings.json` registers a single Stop hook that fires
when Claude finishes generating a turn. The hook reads the
turn's tool calls and the diff, then decides which reviewers
must verdict CLEAN before Claude is allowed to stop.

Routing rules (file pattern → reviewer):

| Files changed                                                    | Reviewer            |
|------------------------------------------------------------------|---------------------|
| `*.py`                                                           | python-principal    |
| `*.go`                                                           | go-principal        |
| `*.ts`, `*.tsx`, `*.js`, `*.jsx`, `*.css`, `*.scss`              | ts-principal        |
| `ARCHITECTURE.md`, `SYSTEM.md`, `*-design.md`, `docs/architecture/`, `docs/adr/`, OR significant structural code change | architect |
| `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `docs/` (excluding architecture/adr) | doc-expert |
| Test files, OR new feature without tests, OR user-visible UI change | qa-engineer       |
| Auth / session / token / crypto / secrets / policy / middleware paths, OR `Dockerfile` / `docker-compose*.yml` / dependency manifests / CI workflows, OR diff matches security-relevant patterns (`Authorization`, `password`, `dangerouslySetInnerHTML`, `shell=True`, `verify=False`, raw SQL concatenation, …) | security-reviewer |

If any required reviewer returns DIRTY, the supervisor invokes
`code-fixer` with that report and re-invokes the reviewer
until CLEAN. Once all required reviewers are CLEAN, Claude is
allowed to stop and the final assistant message is a clean
summary of the original task.

The hook always responds OK (skips the pipeline) when the turn
is read-only, when the diff is trivial (under 15 net lines AND
only comments / whitespace / typo / unexported-rename), when the
last message is a halt-for-approval, or on re-entry.

## How to extend

- **Add a new agent.** Create `.claude/agents/<name>.md` with a
  YAML frontmatter block (`name`, `description`, `tools`,
  `model`) and the standardized output spec (Review summary →
  Critical → Warnings → Suggestions → Verdict). Reference the
  appropriate guideline file via project-relative path
  (`.claude/agents/guidelines/<topic>.md`).
- **Modify a guideline.** Edit the relevant file under
  `.claude/agents/guidelines/`. Keep the shape: Hard rules →
  Idiomatic patterns → Banned patterns → Project-specific
  notes. Project-specific notes cite numbered `CLAUDE.md` rules.
- **Change Stop-hook routing.** Edit the inline `prompt` in
  `.claude/settings.json`. Claude Code's `prompt`-type hooks
  only support inline text; there is no file-reference syntax.
  Restart Claude Code to pick up changes.
- **Override at the user level.** `~/.claude/` settings still
  load on top of project settings — use that for personal-only
  preferences. Project settings always win on conflict.
- **Opt out for an emergency fix.** Pass `--no-hooks` to Claude
  Code to bypass the Stop hook for one session.

---

The agents, guidelines, and audit command are derived from
@pykul's personal `~/.claude/` setup. Methodology evolves in
this repo via PR; user-level `~/.claude/` stays in place for
non-Flightdeck personal use.
