# Flightdeck Plugin for Claude Code

Reports Claude Code tool calls and session lifecycle to your Flightdeck control plane.

## Prerequisites

Set these environment variables before starting Claude Code:

```bash
export FLIGHTDECK_SERVER="http://localhost:4000"
export FLIGHTDECK_TOKEN="tok_dev"
```

## Installation

```bash
claude plugin install flightdeck
```

Or install from a local path:

```bash
claude plugin install /path/to/flightdeck/plugin
```

## Environment variables

| Variable | Required | Default | What it does |
|---|---|---|---|
| `FLIGHTDECK_SERVER` | yes | -- | Base URL of your Flightdeck stack (e.g. `http://localhost:4000`). Hooks fire `POST $FLIGHTDECK_SERVER/ingest/v1/events`. |
| `FLIGHTDECK_TOKEN` | yes | -- | Bearer token used in the `Authorization` header. `tok_dev` in the dev compose. |
| `FLIGHTDECK_CAPTURE_TOOL_INPUTS` | no | `false` | When set to `true` or `1`, captures a sanitised whitelist of tool input fields (`file_path`, `command`, `query`, `pattern`, `prompt`) on each `tool_call` event. Off by default -- mirrors `capture_prompts` in the Python sensor (DECISIONS.md D019). |
| `CLAUDE_SESSION_ID` | no | -- | If set by Claude Code, used as the session id verbatim. Falls back to a stable cwd-keyed id (see Session identity below). |
| `ANTHROPIC_CLAUDE_SESSION_ID` | no | -- | Alternative name for the same purpose. |

## What it reports

| Hook event | Flightdeck event_type | Notes |
|---|---|---|
| First hook invocation per session | `session_start` | Includes runtime context (hostname, os, git branch, orchestration). Sent exactly once per session id. |
| `PreToolUse` | `pre_call` | `tool_name` populated; `tool_input` only when capture is on. |
| `PostToolUse` | `tool_call` | Same fields as `pre_call`, plus `latency_ms` (hook processing time). |
| `Stop` | `session_end` | |

Every event carries `flavor=claude-code`, `agent_type=developer`, and `framework=claude-code`.

## Session identity

The plugin needs a stable session id across every hook invocation in a Claude Code conversation, but each hook runs as its own Node child process so a `process.pid` fallback would create one session per tool call. Resolution order:

1. `CLAUDE_SESSION_ID` env var (if set by Claude Code).
2. `ANTHROPIC_CLAUDE_SESSION_ID` env var.
3. **File-based id, scoped to the current working directory.** A file under `tmpdir()/flightdeck-plugin/session-<sha256(cwd)[:16]>.txt` holds the id. The first hook in a new cwd creates the file atomically (`O_CREAT|O_EXCL`); concurrent first-time invocations converge on the winner's id. Different cwds get different sessions, so multi-project users don't collide.
4. Last-resort `sha256(cwd)` hash if the filesystem is unreadable.

## Sub-agent tracking

When the `Task` tool fires, the current session becomes a parent. The `tool_call` event carries:

- `is_subagent_call: true`
- `parent_session_id: <current session id>`

A future sub-agent emitter can correlate its own `session_start` events back to the parent via this field.

## Privacy

By default no prompt content, no file content, no tool input is captured. Tool names and lifecycle events only.

If `FLIGHTDECK_CAPTURE_TOOL_INPUTS=true` is set, a sanitised whitelist of tool inputs is captured: `file_path`, `command` (≤ 200 chars), `query` (≤ 200 chars), `pattern` (≤ 200 chars), `prompt` (≤ 100 chars). All other fields (notably `content`, the contents written by `Write` / `Edit`) are dropped at the source and never reach the network.

Token counts are not available from Claude Code hooks and are reported as `0`.
