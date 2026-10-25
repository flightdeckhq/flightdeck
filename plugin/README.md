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
- **Every tool call**, successful or failed, with a sanitised whitelist of the tool arguments (file paths, short command and query strings, up to 200 chars each), the tool result, Claude Code's own `tool_use_id` and measured `duration_ms`, and on failure a structured `error` block.
- **Session lifecycle**: `session_start` at first hook (with how the session began: `startup`, `resume`, `clear`, `compact` or `fork`), `session_end` when Claude Code exits (with Claude Code's exit reason).
- **Run-mode signals** in the session context: the Claude Code native session id (when it is a UUID), the version read from the transcript, how the session started (`session_source`; known values include `startup`, `resume`, `clear` and `compact`), the entrypoint (known values include `cli` for a terminal session and `sdk-cli` for `claude -p`; the SDKs set their own), whether a human is attending the session, whether it was launched from inside another Claude Code session, cloud (`CLAUDE_CODE_REMOTE`) and CI markers. Each is passed through as sent, bounded to 64 characters.

Two independent privacy knobs control what content leaves your machine: `captureToolInputs` (default ON) governs the tool-arg whitelist, and `capturePrompts` (default ON) governs the LLM prompt/response content and tool results. Either can be turned off without affecting the other. See the env var table below and the Privacy section.

## Privacy

**Prompt content is captured by default.** This is the opposite of the Python sensor default (`capture_prompts=False`). The reasoning is specific to Claude Code: you are observing your own session on your own machine, and an empty Prompts tab makes the feature useless without improving privacy.

To disable either capture knob:

```bash
export FLIGHTDECK_CAPTURE_PROMPTS=false       # strip LLM prompt/response content
export FLIGHTDECK_CAPTURE_TOOL_INPUTS=false   # strip sanitised tool arguments
```

**Cost follows how the session is billed.** At session start the plugin
runs `claude auth status` once and checks the cloud-provider variables:
a Claude subscription login (Pro, Max, Team, Enterprise) is reported as
`subscription` and its tokens are not counted as spend; an API key,
Amazon Bedrock, Google Vertex AI or Microsoft Foundry session is
`metered` and priced. Claude Code does not say when a subscription runs
on extra usage, so if your Claude Code usage is billed per token, set the
override below. If `claude auth status` cannot run (it is not on the
hook's `PATH`), the plugin falls back to the environment: a set
`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is metered, anything else a
subscription.

```bash
export FLIGHTDECK_BILLING_MODE=metered        # or subscription / local
```

Guarantees that hold regardless of the knob settings:

- Raw file bodies written by `Write` and `Edit` are never forwarded. The sanitiser drops the body field at the source; it never reaches the network.
- Tool arguments outside the whitelist (`file_path`, `command`, `query`, `pattern`, `prompt`) are dropped.
- String values are truncated (`prompt` at 100 chars, everything else at 200 chars).
- `FLIGHTDECK_CAPTURE_PROMPTS=false` zeroes every content field on every event type. The event still ships (so you see the session and token counts on the dashboard), but no prompt or response body is attached.
- The error text of a failed tool call is content too (a command's stderr, an `Edit` failure quoting its `old_string`, a token a failed command printed): it is sent only when both knobs are on. Otherwise the `error` block keeps `error_type`, `error_class` and `interrupted`, and its `message` reads `<redacted>`. The server redacts the same field when the session was started with capture off.
- Credentials in `FLIGHTDECK_SERVER` (`https://user:token@host`) are stripped before any request and never written to a log line; authenticate with `FLIGHTDECK_TOKEN`.
- MCP servers bundled with other Claude Code plugins are reported but not gated by the MCP policy (see *MCP coverage*).

## Environment variables

| Variable | Default | What it does |
|---|---|---|
| `FLIGHTDECK_SERVER` | `http://localhost:4000` | Base URL of your Flightdeck stack. Hooks fire `POST $FLIGHTDECK_SERVER/ingest/v1/events`. |
| `FLIGHTDECK_TOKEN` | `tok_dev` | Bearer token used in the `Authorization` header. The dev compose accepts `tok_dev` when `ENVIRONMENT=dev`; production deployments leave that unset and require an `ftd_` token minted from the Settings page. |
| `FLIGHTDECK_CAPTURE_TOOL_INPUTS` | `true` | Captures a sanitised whitelist of tool input fields on each `tool_call` event. Set to `false` to strip tool inputs. |
| `FLIGHTDECK_CAPTURE_PROMPTS` | `true` | Captures LLM prompts, assistant responses, and tool results. Set to `false` to strip all content bodies from plugin events while keeping metadata and token counts. |
| `FLIGHTDECK_QUIET` | unset | Set to `1` to suppress the `[flightdeck] WARN:` stderr line emitted on every hook invocation when `FLIGHTDECK_TOKEN` is unset (the seed `tok_dev` default is in use). Intended for test suites that intentionally exercise the zero-config default-token path; production deployments should set `FLIGHTDECK_TOKEN` instead so the warning never fires. |
| `CLAUDE_SESSION_ID` | unset | Explicit Flightdeck session id override. Wins over every other resolution step -- use this when you want to force a specific id across processes or tests. |
| `ANTHROPIC_CLAUDE_SESSION_ID` | unset | Alternative name for `CLAUDE_SESSION_ID`, honored second. |
| `FLIGHTDECK_SESSION_END_GRACE_MS` | `800` | How long the `SessionEnd` hook waits for its detached worker before letting it run on. A test knob, capped at 10000; the default keeps the hook inside Claude Code's 1.5 s SessionEnd budget. |
| `CLAUDE_CODE_SESSION_ID` | set by Claude Code | Claude Code's own session id, exported to every hook process. The plugin reads it when a hook payload carries no `session_id` (so callers other than Claude Code still get one marker per session) and reports it on every event as `context.claude_code_session_id`. It is not the Flightdeck session id; see *How it works*. |
| `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_REMOTE`, `CLAUDE_CODE_REMOTE_SESSION_ID`, `CLAUDE_CODE_EXECPATH`, `CI` | set by Claude Code / the CI system | Read only. Surface in the session context as `entrypoint`, `attended`, `child_session`, `remote` / `remote_session_id`, `claude_code_version` and `ci` / `ci_provider`. |

## What gets reported, when

Each row is what the dashboard shows for a given Claude Code hook.

| Claude Code hook | Dashboard events |
|---|---|
| SessionStart | `session_start` with runtime context (hostname, git, frameworks, `supports_directives=false`, the run-mode signals listed above, and `session_source` = the hook's `source`). Sent once per session id. When an MCP Protection Policy applies, also one `policy_mcp_warn` / `policy_mcp_block` per declared MCP server whose decision is not `allow`. |
| UserPromptSubmit | `pre_call` with cached model name and the user prompt (if `capturePrompts=true`). |
| PreToolUse (MCP) | No dashboard event. For tools named `mcp__<server>__<tool>` the plugin applies the MCP Protection Policy cached at SessionStart and writes a Claude Code hook decision to stdout: `deny` when the server is blocked, `allow` when an earlier approval was remembered, `ask` when the server is unknown to an allowlist-mode policy (a `yes` is remembered on PostToolUse and reported as `mcp_policy_user_remembered`). Non-MCP tools, allowed or warned servers, and servers missing from `.mcp.json` fall through to Claude Code's default approval flow. |
| PostToolUse | Any un-emitted assistant turns from the transcript flush as `post_call` events first (token counts, model, response body when capture is on), then the tool execution itself emits a `tool_call` carrying `tool_use_id` and Claude Code's measured tool time as `latency_ms` / `duration_ms` (null on Claude Code versions that don't report it; the plugin never substitutes its own run time). Mid-turn LLM activity is flushed on every tool invocation instead of only at turn end. |
| PostToolUse (MCP) | When the tool name matches `mcp__<server>__<tool>` the plugin emits `mcp_tool_call` instead of the generic `tool_call`, with `mcp_server = {name, source}` as Claude Code reports it. See *MCP coverage* below. |
| PostToolUseFailure | Every tool, not only MCP: the same transcript flush and `tool_call` / `mcp_tool_call` routing as PostToolUse plus a structured `error` block (`error_type=other`, `error_class=PluginToolError`, `message` and `interrupted` when Claude Code reports the failure reached it as an abort). The message is the tool's error text cut at 1000 characters, `tool failed (Claude Code reported no error detail)` when the hook carried none, and `<redacted>` unless both capture knobs are on. A failed `Bash` command, a `Read` on a missing file and an MCP call that errored all land. |
| Stop | `post_call` backstop for the final assistant turn that had no tool follow-up. Turns already flushed by PostToolUse are skipped via per-message dedup. |
| SessionEnd | Final transcript sweep (any last-turn `post_call` missed by Stop) followed by `session_end` with `close_reason=normal_exit` and `end_reason` = the hook's `reason` as sent (known values include `clear`, `resume`, `logout`, `prompt_input_exit` and `other`). The hook invalidates the on-disk session markers, hands the POSTs to a detached worker process and waits up to 0.8 s for it: a local or fast server gets the events before Claude Code exits, a slow one leaves the worker running past the hook, and the hook returns inside Claude Code's 1.5 s SessionEnd budget either way. |
| PreCompact | Synthetic `tool_call` with `tool_name=compact_context` so the timeline shows when Claude Code compacted its context window. |
| SubagentStart | Child `session_start` under the sub-agent's own `session_id`, with `parent_session_id` pointing at the outer session and `agent_role` naming the sub-agent type. Hooks that fire while the sub-agent runs are emitted under the child session id. |
| SubagentStop | Child `session_end` for that same sub-agent session, after flushing any un-emitted turns from the sub-agent's transcript. |

Every event carries `flavor=claude-code`, `agent_type=coding`, and `framework=claude-code`.

Sub-agent tracking: `SubagentStart` / `SubagentStop` emit the sub-agent's own `session_start` / `session_end` (see the table above), linked to the outer session through `parent_session_id` and labelled with `agent_role`, and the sub-agent's interior hooks are emitted under that child session id. On the legacy `Task` tool path the parent's `tool_call` event additionally sets `is_subagent_call=true` and `parent_session_id=<current session id>` as an informational hint.

## MCP coverage

The plugin sees MCP traffic as `mcp__<server>__<tool>` tool invocations on `PostToolUse` and `PostToolUseFailure`. These are routed to the dedicated `mcp_tool_call` event_type with `server_name`, `tool_name`, `transport`, `mcp_server`, `tool_use_id`, `arguments`, `result`, `duration_ms`, and (on failure) `error`. Server fingerprints (transport, command/args, env) are loaded from the project-local `.mcp.json` plus `~/.claude.json` and stamped on `session_start.context.mcp_servers`.

Server identity, in lookup order: the hook's `mcp_server.name` when Claude Code sent it (2.1.274 and later; `source` says where the server was declared, and known values include `project`, `user`, `plugin` and `sdk`), else the server segment of the tool name, rebuilt to Claude Code's `plugin:<plugin>:<server>` key when it carries the `plugin_<plugin>_<server>` prefix (a server bundled with another Claude Code plugin, for example `plugin:claude-mem:mcp-search`, whose tools are named `mcp__plugin_claude-mem_mcp-search__<tool>`). The resolved key is `server_name` on every version; `mcp_server` itself is passed through only when the hook carried it, exactly as sent. The MCP policy gate resolves the server the same way and looks its `.mcp.json` fingerprint up by the resolved key or by the literal tool-name segment, so a project server you declared as `plugin_foo_bar` is still gated. `tool_use_id` and `duration_ms` were recorded from Claude Code 2.1.306 and are null or absent on versions that do not send them; no other field is pinned to a Claude Code version. `server_name`, `tool_name`, `tool_use_id` and the `mcp_server` fields are bounded to 256 characters.

Known limits — by design, not a TODO:

- **`mcp_tool_call` only.** Resource reads, prompt gets, and list operations (`mcp_resource_list/read`, `mcp_prompt_list/get`, `mcp_tool_list`) are invisible from the hook surface. The Python sensor patches the MCP SDK directly and emits all six event types; the plugin emits one — a deliberate trade-off recorded in DECISIONS.md.
- **Tool-name parse is best-effort without `mcp_server`.** Claude Code uses `__` (double underscore) as the server/tool delimiter. When the hook carries `mcp_server`, a server key containing `__` is still split exactly; on older Claude Code versions the plugin splits at the first `__`, emits `server_name=null`, `tool_name=<rest>` for an unparseable name, and writes one stderr line per occurrence. A plugin name containing `_` is likewise only split exactly when `mcp_server` is present.
- **Plugin-bundled servers are reported, not gated.** Their declaration lives in the other plugin's own `.mcp.json`, not in the project's, so `transport` is `null` and the MCP Protection Policy cannot fingerprint them: calls to them proceed as Claude Code decides, and only the `mcp_tool_call` events show they happened.
- **Mid-session reconnects are not observable.** A server added via `claude mcp add` after the session started is seen at tool-call time but won't appear in `session_start.context.mcp_servers` (which is captured once and never refreshed). Transport falls back to `null` for that server until the next Claude Code invocation rebuilds the fingerprint cache.
- **Sanitiser bypassed for MCP arguments.** The whitelist that drops fields like file bodies on generic tools doesn't apply to MCP — its keep-list (`file_path`, `command`, `query`, `pattern`, `prompt`) would empty most MCP payloads. `captureToolInputs=false` still strips the `arguments` field entirely.

Enforcement. `SessionStart` fetches the global and `claude-code` flavor MCP policies from `$FLIGHTDECK_SERVER/api` and caches them for the invocation; it also emits one `policy_mcp_warn` / `policy_mcp_block` event per declared server whose decision is not `allow`. `PreToolUse` then gates every `mcp__<server>__<tool>` call through Claude Code's hook decision contract (`hookSpecificOutput.permissionDecision`): a blocked server answers `deny` with the reason `MCP policy blocked tool call to <server> (<scope>, <path>)`, a server unknown to an allowlist-mode policy answers `ask` so Claude Code shows its own permission prompt (an approval is remembered on this machine and answers `allow` next time), and allowed or warned servers get no decision so Claude Code's normal flow applies. Policy evaluation fails open: with no cached policy, calls proceed.

## Observer-class limitation

Apart from the MCP policy gate (see MCP coverage), the plugin is observation-only. It reports what Claude Code does; it cannot stop a session or change what the model does.

- No Stop Agent button on claude-code sessions in the dashboard.
- No kill switch, no mid-call interruption.
- No token-budget enforcement and no model degradation.

The plugin sets `context.supports_directives=false` on session start so the dashboard hides directive UI for these sessions rather than showing controls that silently fail. This is a deliberate trade-off: the plugin is non-intrusive by design and can never interfere with your Claude Code work. If you need kill-switch or policy-enforcement behavior on actual production agents, use the Python sensor (which sits in the LLM call path and can act on returned directives).

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

The plugin logs one line per failed POST, capped at two lines per hook invocation (one for the session-start check and one for the event). Either the stack is not running, or `FLIGHTDECK_SERVER` points at the wrong host. Claude Code itself is unaffected: the plugin fails open and exits 0 so hooks remain healthy. The one exception is the `session_end`: its POST is made by the detached SessionEnd worker, whose failed-POST line goes to the worker log instead of the terminal (see below).

### `session_end` never arrives, or the session stays open after exit

The `SessionEnd` hook hands its POSTs to a detached worker process (Claude Code gives SessionEnd hooks 1.5 seconds in total). The worker's stderr is appended to the worker log:

- Linux / macOS: `$TMPDIR/flightdeck-plugin/session-end-worker.log` (`/tmp/flightdeck-plugin/session-end-worker.log` when `TMPDIR` is unset)
- Windows: `%TEMP%\flightdeck-plugin\session-end-worker.log`

A `cannot reach <server>: <reason>` line there means the final flush or the `session_end` was refused; the session then closes through the server's stale / lost / reaper path. The log also receives the worker's flush-deadline notice, a hook-event parse failure and a `hook failed` line for an unexpected error. The directory is created owner-only (0700; an existing directory is tightened with a best-effort `chmod`), the file owner-only (0600) and opened without following symlinks; the file is truncated once it passes 256 KiB. The worker gives up an unflushed backlog after 20 seconds against a dead server, and a machine torn down right after `claude -p` returns (an ephemeral CI runner) can lose that session's final flush.

### Server was down when Claude Code started; events resume on recovery

Each hook invocation is a fresh Node process with no disk-persisted mute state. When the Flightdeck stack comes back up mid-session, the next hook's POST lands automatically. The server lazy-creates the session row from that first post-recovery event so the session appears in the dashboard with tokens counted from the recovery point onward. No manual cleanup of `$TMPDIR/flightdeck-plugin` is needed.

Outage-window events (LLM calls that fired while the server was unreachable) are not retroactively recovered; the plugin is intentionally unbuffered so it cannot block Claude Code on a stuck queue. You lose the pre-recovery events and gain every post-recovery event.

### Prompts aren't being captured

Check `FLIGHTDECK_CAPTURE_PROMPTS`. If it's `false` or `0` or `off`, prompt content is stripped even though events still ship. The dashboard Prompts tab shows "Prompt capture is not enabled for this deployment" in that case. Set the var to `true` (or unset it) and start a new Claude Code session; old sessions won't retroactively grow content.

### Mid-turn tokens don't update in real time

Token counts surface on `post_call` events. The plugin flushes `post_call` on every `PostToolUse`, so turns that include tool calls surface immediately. Turns with no tool calls (e.g. a plain text response) only produce a `post_call` on `Stop`, which fires after Claude Code finishes responding. This is expected: without a tool use there is no earlier hook to flush on.

### Sessions appear with no LLM calls

Most `post_call` events land via the PostToolUse flush. `Stop` and `SessionEnd` act as backstops for the final turn that had no tool follow-up. If turns are still missing:

- Make sure `SessionEnd` is wired in `plugin/hooks/hooks.json` (the plugin ships with all ten hooks -- `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `SessionEnd`, `PreCompact`, `SubagentStart`, `SubagentStop` -- and a custom `hooks.json` override might have dropped some).
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

Confirm with `/bin/sh -c 'node --version'`. The plugin requires Node 22 or later (`engines.node` in `package.json`).

## How it works

Fire-and-forget HTTP. Claude Code invokes each hook as a detached child process. The plugin reads the hook event from stdin, resolves session identity (see below), builds an event payload, POSTs it to `$FLIGHTDECK_SERVER/ingest/v1/events`, and exits. On failure the plugin logs one stderr line and exits 0. Claude Code never blocks on the plugin.

Session identity resolution. Precedence, top wins:

1. `CLAUDE_SESSION_ID` env var.
2. `ANTHROPIC_CLAUDE_SESSION_ID` env var.
3. Marker file cache at `$TMPDIR/flightdeck-plugin/session-<sha256(native session id)[:16]>.txt`, keyed on Claude Code's own per-invocation session id: the `session_id` on every hook event, or `$CLAUDE_CODE_SESSION_ID` from the hook environment when the payload has none. The first hook of an invocation writes it; every later hook in the same run reads it verbatim.
4. A fresh random UUID (RFC 4122 v4), written to that marker file. Each Claude Code invocation is therefore one session row; continuity across invocations lives in `agent_id`, a stable UUID derived from agent type, `user@hostname`, client type and agent name. The native Claude Code session id travels alongside as `context.claude_code_session_id`, so a dashboard session maps back to its transcript.
5. When neither the hook event nor the environment names a session (a caller other than Claude Code), the marker is keyed on `sha256(cwd)[:16]` and the plugin prints one stderr warning.
6. An ephemeral `sha256(time, pid, cwd)[:32]` when `$TMPDIR` itself is unusable.

`SessionEnd` deletes the marker, so `/clear` or a new `claude` run mints a fresh session id (delete `$TMPDIR/flightdeck-plugin/` by hand to force one earlier).

SessionEnd and the 1.5 s budget. Claude Code gives SessionEnd hooks 1.5 seconds in total before it exits, and a plugin cannot raise that. The SessionEnd hook therefore does no network work itself: it resolves the session id, deletes the markers above, and re-launches this same script as a detached worker (`observe_cli.mjs --session-end-worker`, hook event on stdin, session id in `CLAUDE_SESSION_ID`) which flushes any remaining transcript turns and POSTs the `session_end`; the worker never touches the session markers and stops an unflushed backlog after 20 seconds. The hook waits up to 0.8 s for the worker, so a local or fast server receives the events before Claude Code exits; past that the worker keeps running on its own. Its stderr goes to the worker log described under *Troubleshooting*.

No background threads inside a hook. No polling. The only state the plugin persists across hook invocations is a small set of markers in `$TMPDIR/flightdeck-plugin/`:

- `session-<hash>.txt`: the session id for the current Claude Code invocation (a random UUID), keyed on the native Claude Code session id.
- `mcp-policy-<sid>.json`: the MCP policy fetched at `SessionStart` and read by every `PreToolUse`; deleted at `SessionEnd`.
- `started-<sid>.txt`: marks that session_start was attempted (so subsequent hooks don't duplicate).
- `model-<sid>.txt`: caches the model name so `pre_call` events on older Claude Code versions can carry a non-null model.
- `emitted-<messageId>.txt`: per-message dedup so Stop / SessionEnd don't re-emit turns that PostToolUse already flushed.
- `session-end-worker.log`: stderr of the detached SessionEnd workers (failed POSTs, the flush-deadline notice, parse failures, `hook failed` lines); owner-only, opened without following symlinks, truncated once it passes 256 KiB.

The directory is created owner-only (0700; an existing one is tightened with a best-effort `chmod`). Values copied from the hook payload and the environment are bounded before they leave the machine, in UTF-8 bytes as ingestion counts them: the run-mode signals and `end_reason` at 64 bytes, `server_name`, `tool_name`, `tool_use_id` and the `mcp_server` fields at 256, the error message at 1000 characters; anything longer, or containing control characters, is dropped or cut rather than sent.

All of these are safe to delete; the plugin recreates what it needs on the next hook.

Windows. The script's entry check resolves both its own path and the invoked one (realpath, case-insensitive on Windows), so a forward-slash or differently cased `${CLAUDE_PLUGIN_ROOT}` expansion or a symlinked plugin directory still runs the hook.

For the deeper architecture (ingestion pipeline, session state machine, NOTIFY/WebSocket push, revive/create semantics), see ARCHITECTURE.md.

## Testing

The plugin has a Node-only unit suite using the built-in test runner (no npm dependencies, matching the plugin's zero-dep constraint):

```bash
cd plugin
node --test tests/*.test.mjs
```

Or via the top-level Makefile: `make test-plugin`. The suite covers the uuid5 helper (Python-canonical vectors), the session-identity resolution chain, the end-to-end hook flow against an in-process capture server, and a replay of hook payloads recorded from a real Claude Code session (`tests/fixtures/claude-code-2.1.306-hooks.jsonl`) in which every emitted event is checked against the ingestion validator's rules -- a stub server accepts anything, so without that check a payload the real API rejects with 400 would pass the suite while the plugin fails open and drops it.

## Updating

A marketplace install stays on the version it was installed at. Claude Code auto-updates plugins only from a marketplace whose auto-update you turned on (**Marketplaces** in `/plugin`, select `flightdeck-plugins`, **Enable auto-update**); otherwise run:

```bash
claude plugin update flightdeck@flightdeck-plugins
```

or `/plugin marketplace update flightdeck-plugins` inside a session. A new copy is fetched only when the plugin version changes, which every Flightdeck release does. `claude --plugin-dir` loads the checkout directly, so there a `git pull` is the update.

## Uninstall

Remove the plugin with whatever Claude Code loader you used to install it (`claude --plugin-dir` is session-scoped and drops at exit; marketplace installs use `claude plugin remove`). Event history stays on the Flightdeck side until you delete it from the dashboard or let retention expire.
