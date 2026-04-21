# Flightdeck Plugin for Claude Code

A Claude Code plugin that reports LLM call metadata, tool invocations, and token counts from Claude Code sessions to a Flightdeck stack. The plugin reads defaults for the local `make dev` stack; set `FLIGHTDECK_SERVER` and `FLIGHTDECK_TOKEN` to point at a different stack. Each hook invocation runs as a short-lived child process: read stdin, POST, exit.

## Quickstart

Prereq: a running Flightdeck stack. The fastest path is `make dev` in the Flightdeck repo (dashboard on `http://localhost:4000`, seeded token `tok_dev`).

```bash
claude --plugin-dir /path/to/flightdeck/plugin
```

Start using Claude Code normally. Open the dashboard. Your session appears in the Fleet view within a few seconds, tagged `flavor=claude-code`, and events stream in as you work. No env vars required for the default dev stack.

Hosted Flightdeck or a non-default port? Set two vars before invoking `claude`:

```bash
export FLIGHTDECK_SERVER="https://flightdeck.example.com"
export FLIGHTDECK_TOKEN="ftd_..."
```

## What gets captured

By default, every Claude Code session produces:

- **Session metadata** on session start: flavor (`claude-code`), hostname, OS, Node version, git commit/branch/repo, orchestration (docker-compose / kubernetes if detected), and the frameworks list.
- **Every LLM call** (both `pre_call` on user prompt submit and `post_call` on assistant turn completion) with token counts from the Claude Code JSONL transcript: `tokens_input`, `tokens_output`, `tokens_cache_read`, `tokens_cache_creation`, plus model name and latency.
- **Every tool call** with a sanitised whitelist of the tool arguments (file paths, short command and query strings, up to 200 chars each) and the tool result.
- **Session lifecycle**: `session_start` at first hook, `session_end` when Claude Code exits.

Two independent privacy knobs control what content leaves your machine: `captureToolInputs` (default ON) governs the tool-arg whitelist, and `capturePrompts` (default ON) governs the LLM prompt/response content and tool results. Either can be turned off without affecting the other. See the env var table below and the Privacy section.

## Privacy

**Prompt content is captured by default.** This is the opposite of the Python sensor default (`capture_prompts=False`). The reasoning is specific to Claude Code: you are observing your own session on your own machine, and an empty Prompts tab makes the feature useless without improving privacy. See DECISIONS.md D103.

To disable either capture knob:

```bash
export FLIGHTDECK_CAPTURE_PROMPTS=false       # strip LLM prompt/response content
export FLIGHTDECK_CAPTURE_TOOL_INPUTS=false   # strip sanitised tool arguments
```

Guarantees that hold regardless of the knob settings:

- Raw file bodies written by `Write` and `Edit` are never forwarded. The sanitiser drops the body field at the source; it never reaches the network.
- Tool arguments outside the whitelist (`file_path`, `command`, `query`, `pattern`, `prompt`) are dropped.
- String values are truncated (`prompt` at 100 chars, everything else at 200 chars).
- `FLIGHTDECK_CAPTURE_PROMPTS=false` zeroes every content field on every event type. The event still ships (so you see the session and token counts on the dashboard), but no prompt or response body is attached.

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `FLIGHTDECK_SERVER` | `http://localhost:4000` | Base URL of your Flightdeck stack. Hooks fire `POST $FLIGHTDECK_SERVER/ingest/v1/events`. |
| `FLIGHTDECK_TOKEN` | `tok_dev` | Bearer token used in the `Authorization` header. The dev compose accepts `tok_dev` when `ENVIRONMENT=dev`; production deployments leave that unset and require an `ftd_` token minted from the Settings page. |
| `FLIGHTDECK_CAPTURE_TOOL_INPUTS` | `true` | Captures a sanitised whitelist of tool input fields on each `tool_call` event. Set to `false` to strip tool inputs. |
| `FLIGHTDECK_CAPTURE_PROMPTS` | `true` | Captures LLM prompts, assistant responses, and tool results. Set to `false` to strip all content bodies from plugin events while keeping metadata and token counts. |
| `CLAUDE_SESSION_ID` | unset | Explicit session id override. Wins over every other resolution step -- use this when you want to force a specific id across processes or tests. |
| `ANTHROPIC_CLAUDE_SESSION_ID` | unset | Alternative name for `CLAUDE_SESSION_ID`, honored second. |

## What gets reported, when

Each row is what the dashboard shows for a given Claude Code hook.

| Claude Code hook | Dashboard events |
|---|---|
| SessionStart | `session_start` with runtime context (hostname, git, frameworks, `supports_directives=false`). Sent once per session id. |
| UserPromptSubmit | `pre_call` with cached model name and the user prompt (if `capturePrompts=true`). |
| PostToolUse | Any un-emitted assistant turns from the transcript flush as `post_call` events first (token counts, model, response body when capture is on), then the tool execution itself emits a `tool_call`. Mid-turn LLM activity is flushed on every tool invocation instead of only at turn end. |
| Stop | `post_call` backstop for the final assistant turn that had no tool follow-up. Turns already flushed by PostToolUse are skipped via per-message dedup. |
| SessionEnd | Final transcript sweep (any last-turn `post_call` missed by Stop) followed by `session_end`. |
| PreCompact | Synthetic `tool_call` with `tool_name=compact_context` so the timeline shows when Claude Code compacted its context window. |

Every event carries `flavor=claude-code`, `agent_type=developer`, and `framework=claude-code`.

Sub-agent tracking: when the `Task` tool fires, the `tool_call` event sets `is_subagent_call=true` and `parent_session_id=<current session id>` so a future sub-agent emitter can correlate.

## Observer-class limitation

The plugin is observation-only. It reports what Claude Code does; it cannot change what Claude Code does.

- No Stop Agent button on claude-code sessions in the dashboard.
- No kill switch, no mid-call interruption.
- No token-budget enforcement, no model degradation, no policy blocking.

The plugin sets `context.supports_directives=false` on session start so the dashboard hides directive UI for these sessions rather than showing controls that silently fail. This is a deliberate trade-off: the plugin is non-intrusive by design and can never interfere with your Claude Code work. If you need kill-switch or policy-enforcement behavior on actual production agents, use the Python sensor (which sits in the LLM call path and can act on returned directives). See DECISIONS.md D109.

## Troubleshooting

### "I don't see my session at all"

Quick health check:

```bash
curl -s -o /dev/null -w "%{http_code}\n" "$FLIGHTDECK_SERVER/ingest/health"
```

Expected: `200`. If you get `000`, `502`, or `504`, the ingestion endpoint isn't reachable; check `FLIGHTDECK_SERVER` and that the stack is actually running (`docker ps` should show `docker-ingestion-1` healthy). If you get `401` or `403`, the token is wrong.

### "cannot reach" stderr line on every Claude run

```
[flightdeck] cannot reach http://localhost:4000: ECONNREFUSED. events dropped for this session.
```

The plugin logs one line per failed POST, capped at two lines per hook invocation (one for the session-start check and one for the event). Either the stack is not running, or `FLIGHTDECK_SERVER` points at the wrong host. Claude Code itself is unaffected: the plugin fails open and exits 0 so hooks remain healthy.

### Server was down when Claude Code started; events resume on recovery

Each hook invocation is a fresh Node process with no disk-persisted mute state. When the Flightdeck stack comes back up mid-session, the next hook's POST lands automatically. The server lazy-creates the session row from that first post-recovery event (see DECISIONS.md D106) so the session appears in the dashboard with tokens counted from the recovery point onward. No manual cleanup of `$TMPDIR/flightdeck-plugin` is needed.

Outage-window events (LLM calls that fired while the server was unreachable) are not retroactively recovered; the plugin is intentionally unbuffered so it cannot block Claude Code on a stuck queue. You lose the pre-recovery events and gain every post-recovery event.

### Prompts aren't being captured

Check `FLIGHTDECK_CAPTURE_PROMPTS`. If it's `false` or `0` or `off`, prompt content is stripped even though events still ship. The dashboard Prompts tab shows "Prompt capture is not enabled for this deployment" in that case. Set the var to `true` (or unset it) and start a new Claude Code session; old sessions won't retroactively grow content.

### Mid-turn tokens don't update in real time

Token counts surface on `post_call` events. The plugin flushes `post_call` on every `PostToolUse` (see D107), so turns that include tool calls surface immediately. Turns with no tool calls (e.g. a plain text response) only produce a `post_call` on `Stop`, which fires after Claude Code finishes responding. This is expected: without a tool use there is no earlier hook to flush on.

### Sessions appear with no LLM calls

Most `post_call` events land via the PostToolUse flush. `Stop` and `SessionEnd` act as backstops for the final turn that had no tool follow-up. If turns are still missing:

- Make sure `SessionEnd` is wired in `plugin/hooks/hooks.json` (the plugin ships with all six hooks; a custom `hooks.json` override might have dropped some).
- Check that Claude Code's JSONL transcript is readable at the path the hooks pass in.
- Confirm the session did not exit via `SIGKILL` before the last hook could run.

### Hook reports `/bin/sh: 1: node: not found`

Claude Code invokes hooks through `/bin/sh`, which does not do WSL's automatic `.exe` extension lookup. If your WSL install only has the Windows-side `node.exe` on PATH, the bare `node` invocation in `hooks.json` fails. Install Node.js natively inside WSL:

```bash
# via nvm (preferred, per-user)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
nvm install --lts

# or via NodeSource apt (system-wide)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

Confirm with `/bin/sh -c 'node --version'`. The plugin works with Node v20+.

## How it works

Fire-and-forget HTTP. Claude Code invokes each hook as a detached child process. The plugin reads the hook event from stdin, resolves session identity (see below), builds an event payload, POSTs it to `$FLIGHTDECK_SERVER/ingest/v1/events`, and exits. On failure the plugin logs one stderr line and exits 0. Claude Code never blocks on the plugin.

Session identity resolution (D113). Precedence, top wins:

1. `CLAUDE_SESSION_ID` env var.
2. `ANTHROPIC_CLAUDE_SESSION_ID` env var.
3. RFC 4122 v5 UUID derived from `(user, hostname, repo remote, branch)`. Same laptop + same repo + same branch converges on the same session across Claude Code spawns, so a developer running `claude` daily in one repo sees one ongoing session row instead of 30+ fleet-view rows.
4. Marker file cache at `$TMPDIR/flightdeck-plugin/session-<sha256(cwd)[:16]>.txt`. The first hook to run populates it; subsequent hooks in the same cwd read it directly and skip the git probes.
5. `session_id` from the hook event payload (Claude Code's own per-spawn id). Demoted safety net -- used only when env vars are unset, git is unavailable, and the marker file can't be written.
6. `sha256(cwd)[:32]` as the final deterministic fallback when `$TMPDIR` itself is broken.

Branch is part of the identity: intentionally switching branches produces a different session. Detached HEAD maps to `detached-<short_sha>`. Mid-session branch switches reuse the cached UUID until the Claude Code invocation ends (clear `$TMPDIR/flightdeck-plugin/` to start a fresh identity cycle).

No background threads. No polling. The only state the plugin persists across hook invocations is a small set of markers in `$TMPDIR/flightdeck-plugin/`:

- `session-<hash>.txt`: the resolved session id for a given cwd (normally the derived stable UUID).
- `started-<sid>.txt`: marks that session_start was attempted (so subsequent hooks don't duplicate).
- `model-<sid>.txt`: caches the model name so `pre_call` events on older Claude Code versions can carry a non-null model.
- `emitted-<messageId>.txt`: per-message dedup so Stop / SessionEnd don't re-emit turns that PostToolUse already flushed.

All of these are safe to delete; the plugin recreates what it needs on the next hook.

For the deeper architecture (ingestion pipeline, session state machine, NOTIFY/WebSocket push, revive/create semantics), see ARCHITECTURE.md.

## Testing

The plugin has a Node-only unit suite using the built-in test runner (no npm dependencies, matching the plugin's zero-dep constraint):

```bash
cd plugin
node --test tests/*.test.mjs
```

Or via the top-level Makefile: `make test-plugin`. The suite covers the uuid5 helper (Python-canonical vectors), the session-identity resolution chain, and the end-to-end hook flow against an in-process capture server.

## Uninstall

Remove the plugin with whatever Claude Code loader you used to install it (`claude --plugin-dir` is session-scoped and drops at exit; marketplace installs use `claude plugin remove`). Event history stays on the Flightdeck side until you delete it from the dashboard or let retention expire.
