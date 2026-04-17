# Flightdeck Plugin for Claude Code

Reports Claude Code tool calls and session lifecycle to your Flightdeck control plane.

## Prerequisites

Set these environment variables before starting Claude Code:

```bash
export FLIGHTDECK_SERVER="http://localhost:4000"
export FLIGHTDECK_TOKEN="tok_dev"
```

## Installation

The plugin is not yet published to a marketplace. Load it from the local repo for the session:

```bash
claude --plugin-dir /path/to/flightdeck/plugin
```

Validate the manifest and hook config before first use:

```bash
claude plugin validate /path/to/flightdeck/plugin
```

## Environment variables

| Variable | Required | Default | What it does |
|---|---|---|---|
| `FLIGHTDECK_SERVER` | yes | -- | Base URL of your Flightdeck stack (e.g. `http://localhost:4000`). Hooks fire `POST $FLIGHTDECK_SERVER/ingest/v1/events`. |
| `FLIGHTDECK_TOKEN` | yes | -- | Bearer token used in the `Authorization` header. `tok_dev` in the dev compose. |
| `FLIGHTDECK_CAPTURE_TOOL_INPUTS` | no | `true` | Captures a sanitised whitelist of tool input fields (`file_path`, `command`, `query`, `pattern`, `prompt`) on each `tool_call` event. Set to `false` to strip tool inputs from plugin events. |
| `FLIGHTDECK_CAPTURE_PROMPTS` | no | `true` | Captures LLM call content (user prompts, assistant response, tool uses) on `post_call` events, and tool outputs on `tool_call` events. On by default for the plugin because a developer running `claude` locally is observing their own session; the Python sensor keeps `capture_prompts=False` for the same knob because it observes production traffic (DECISIONS.md D019, D103). Set to `false` to opt out. |
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

The plugin is tuned for the developer-observing-their-own-session case: a sanitised whitelist of tool inputs (`FLIGHTDECK_CAPTURE_TOOL_INPUTS=true`) and LLM call content (`FLIGHTDECK_CAPTURE_PROMPTS=true`) are both captured by default so the dashboard Prompts tab shows real activity without any extra setup. This is the inverse of the Python sensor's default (`capture_prompts=False`), which is sized for production observability where prompts may carry PII and proprietary context. Different product surfaces, different safe defaults -- see DECISIONS.md D019 and D103.

Even with both knobs on, the plugin never forwards raw file bodies written by `Write` / `Edit`. Tool inputs are restricted to a whitelist -- `file_path`, `command` (≤ 200 chars), `query` (≤ 200 chars), `pattern` (≤ 200 chars), `prompt` (≤ 100 chars). Every other field is dropped at the source and never reaches the network. Set `FLIGHTDECK_CAPTURE_PROMPTS=false` to strip LLM call content from events; set `FLIGHTDECK_CAPTURE_TOOL_INPUTS=false` to strip tool inputs. Both can be turned off independently.

Token counts are read from Claude Code's JSONL transcript on every `Stop` hook and emitted with the same breakdown (`tokens_input`, `tokens_output`, `tokens_cache_read`, `tokens_cache_creation`) that the Python sensor emits for direct SDK calls. See DECISIONS.md D100.

## Troubleshooting

### Hook reports `/bin/sh: 1: node: not found`

Claude Code invokes hooks through `/bin/sh`, which does not do WSL's automatic `.exe` extension lookup. If your WSL install only has the Windows-side `node.exe` on `PATH`, the bare `node` invocation in `hooks.json` will fail. The symptom looks like:

```
● Ran 1 stop hook (ctrl+o to expand)
  ⎿ Stop hook error: Failed with non-blocking status code:
    /bin/sh: 1: node: not found
```

Fix: install Node.js natively inside your WSL distribution. Recommended options, any of which resolves the issue:

```bash
# via nvm (preferred -- keeps Node versions scoped per user)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install --lts

# or via the NodeSource apt repo (requires sudo)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

After install, confirm `/bin/sh -c 'node --version'` prints a version. The plugin does not require a specific Node version; v20+ is known-good. See the Phase 2 incident notes in `CLAUDE.md` for the root-cause history.

### "cannot reach" stderr line on every claude run

```
[flightdeck] cannot reach http://localhost:4000: ECONNREFUSED. events dropped for this session.
```

The plugin printed this once per session then silently dropped subsequent POSTs. Either the stack is not running (`make dev` in the Flightdeck repo), or `FLIGHTDECK_SERVER` points at the wrong host. Claude Code itself is not affected -- the plugin fails open.

A stale unreachable flag in `$TMPDIR/flightdeck-plugin/unreachable-<sessionId>.flag` can keep the plugin from re-attempting POSTs within the same session after the stack comes back up. `rm -rf $TMPDIR/flightdeck-plugin` clears every plugin marker. Session ids change each time Claude Code starts a new conversation, so a fresh `claude` invocation already bypasses the flag.

### Sessions appear with no LLM calls

Stop hook fires when Claude finishes responding, including between tool turns. In print mode (`claude -p`) the hook can fire before the final turn is flushed to the transcript; the plugin also sweeps the transcript on `SessionEnd` to catch any turns `Stop` missed. If you still see missing turns, make sure the SessionEnd hook is wired in `plugin/hooks/hooks.json` and that the session did not exit via `SIGKILL` before the hook could run.
