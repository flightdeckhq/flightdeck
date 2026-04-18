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

| Hook event | Flightdeck event_type(s) | Notes |
|---|---|---|
| First hook invocation per session | `session_start` | Includes runtime context (hostname, os, git branch, orchestration) and `supports_directives=false`. Sent exactly once per session id. |
| `PreToolUse` | `pre_call` | `tool_name` populated; `tool_input` only when capture is on. |
| `PostToolUse` | `post_call` (flushed) + `tool_call` | Flushes any un-emitted assistant turns from the transcript as `post_call` events first (D107), then emits the `tool_call` itself. Mid-turn LLM activity surfaces in real time instead of batching at `Stop`. Per-`message.id` disk-marker dedup keeps this idempotent with `Stop`. |
| `Stop` | `post_call` (backstop) | Emits `post_call` for the final assistant turn that had no tool follow-up. Any turns already flushed by `PostToolUse` are skipped via the dedup marker. |
| `SessionEnd` | `post_call` (last-turn flush) + `session_end` | Final sweep of the transcript in case `Stop` fired before the last turn was flushed, then the session-teardown event. |
| `PreCompact` | `tool_call` | Synthetic `tool_name=compact_context` so the dashboard timeline shows the compaction event. |

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

The plugin logs one line per failed POST, with at most two lines per hook invocation (one for `ensureSessionStarted` and one for the event itself). Either the stack is not running (`make dev` in the Flightdeck repo), or `FLIGHTDECK_SERVER` points at the wrong host. Claude Code itself is not affected -- the plugin fails open and exits 0 so hooks remain healthy.

### Server was down when Claude Code started -- events resume on recovery

Each hook invocation is a fresh Node process with no disk-persisted mute state, so the plugin retries its POST on every hook. When the Flightdeck stack comes back up mid-session, the next hook's POST lands automatically. The server lazy-creates the session row from that first post-recovery event (D106) so the session appears in the dashboard with tokens counted from the moment the stack recovered. No manual intervention or `rm -rf $TMPDIR/flightdeck-plugin` is needed.

### Sessions appear with no LLM calls

Most `post_call` events now land via the `PostToolUse` mid-turn flush (D107), with `Stop` and `SessionEnd` acting as backstops for the final turn that had no tool follow-up. If you still see missing LLM calls, make sure the `SessionEnd` hook is wired in `plugin/hooks/hooks.json`, that Claude Code's JSONL transcript is readable at the path the hooks pass in, and that the session did not exit via `SIGKILL` before the last hook could run.
