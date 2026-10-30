---
name: flightdeck
description: Explains what the Flightdeck plugin records about this Claude Code session, where it shows up, which environment variables control capture and enforcement, and how MCP policy decisions reach the session. Use when the user asks what Flightdeck sees, why a tool call was refused by an MCP policy, or how to turn capture off.
---

# Flightdeck

Flightdeck is a self-hosted control plane for AI agents. With this plugin
loaded, the current Claude Code session streams lifecycle, tool and LLM
events to the Flightdeck server configured for this machine, and the
session appears in the Fleet view next to production agents.

## What the plugin records

Every hook Claude Code exposes runs the same script, so the session is
reported from start to end:

- Session start and end, including sub-agent sessions spawned through the
  Agent tool (reported under their own session id, linked to the parent).
- Every tool call by name, successful or failed, with Claude Code's
  measured duration and `tool_use_id`, a structured error on failure
  (its text only while both capture flags are on; `<redacted>`
  otherwise), and a sanitised whitelist of arguments (`file_path`,
  `command`, `query`, `pattern`, `prompt`) while
  `FLIGHTDECK_CAPTURE_TOOL_INPUTS` is on. MCP tool calls carry their full
  arguments because the whitelist would empty them, plus the server
  identity Claude Code reports (`mcp_server`) when it sends one.
- Every LLM turn read from the session transcript: model, input and output
  tokens, cache tokens (with their one-hour share), thinking tokens,
  service tier, data residency, web search counts, stop reason, latency,
  and the prompt and response bodies while `FLIGHTDECK_CAPTURE_PROMPTS`
  is on. Each turn also carries the session's billing mode: a Claude
  subscription login is `subscription` (not counted as spend), an API
  key or a Bedrock / Vertex AI / Foundry session is `metered`.
- A turn that ends on an API error (rate limit, overload, authentication,
  billing, unknown model) as an `llm_error` with the error type and Claude
  Code's error code; the error text only while `FLIGHTDECK_CAPTURE_PROMPTS`
  is on.
- Context compactions (started and finished, with the generated summary
  while `FLIGHTDECK_CAPTURE_PROMPTS` is on) and model switches, as
  `session_signal` events; the MCP servers declared in `.mcp.json`.
- MCP policy decisions: when a server is warned or blocked by the
  Flightdeck MCP policy for this flavor, the session emits a
  `policy_mcp_warn` or `policy_mcp_block` event.

Prompt capture is on by default for this plugin because you are observing
your own session on your own machine. The Python sensor used for
production agents defaults the other way.

## Where the session shows up

Open the dashboard at the configured server (default
`http://localhost:4000`). The session is stamped with:

- flavor `claude-code`
- agent type `coding`
- client type `claude_code`
- a context block with the native Claude Code session id, the Claude
  Code version from the transcript, how the session started (known
  values include `startup`, `resume`, `clear` and `compact`), the
  entrypoint (known values include `cli` and `sdk-cli`), whether a human
  is attending it, and cloud / CI markers when present

Filter the Fleet view by flavor `claude-code` to see only Claude Code
sessions. The session drawer shows tool calls, LLM turns, token totals and
the Prompts tab (empty with a clear notice when capture is off).

## MCP policy enforcement

Before each `mcp__<server>__<tool>` call the plugin evaluates the MCP
policy fetched at session start for flavor `claude-code`:

- `allow` entries let the call through silently.
- `deny` entries with `block` enforcement refuse the call. The tool result
  reads `MCP policy blocked tool call to <server> (<scope>, <path>)`.
- A server unknown to an allowlist-mode policy triggers Claude Code's own
  permission prompt. Approving it once is remembered on this machine.

Operators change the policy in the dashboard under MCP policies. The
plugin re-reads it at the next session start.

## Configuration

The server and token are plugin options: in `/plugin`, select
**flightdeck** on the **Installed** tab and choose **Configure options**.
The token is kept in Claude Code's credential store. `FLIGHTDECK_SERVER`
and `FLIGHTDECK_TOKEN` override the saved options for one shell or run.

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `FLIGHTDECK_SERVER` | the `server` option, else `http://localhost:4000` | Control plane base URL; events go to `/ingest`, policies come from `/api`. |
| `FLIGHTDECK_TOKEN` | the `token` option, else `tok_dev` | Access token. The default is the development seed token and prints a warning; set a real token outside local development. |
| `FLIGHTDECK_CAPTURE_PROMPTS` | `true` | `false` strips prompt, response and tool-result bodies while keeping metadata and token counts. |
| `FLIGHTDECK_CAPTURE_TOOL_INPUTS` | `true` | `false` strips the sanitised tool arguments. |
| `FLIGHTDECK_BILLING_MODE` | detected | `metered`, `subscription` or `local`; overrides the billing mode the plugin detects from `claude auth status` and the cloud-provider variables (set `metered` when a subscription runs on extra usage). |
| `FLIGHTDECK_QUIET` | unset | `1` silences the default-token warning. |
| `CLAUDE_SESSION_ID` | unset | Forces the session id reported to Flightdeck. |
| `CLAUDE_CODE_SESSION_ID` | set by Claude Code | Claude Code's own session id; reported as `context.claude_code_session_id` and used to key the per-session marker when a hook payload has no `session_id`. |

## Failure behaviour

The plugin never blocks Claude Code. If the server is unreachable it
prints one line to stderr per failed request and exits successfully, and
the next hook tries again. The `session_end` is posted by a detached
worker after the hook returns (Claude Code allows SessionEnd hooks 1.5
seconds); its failed-request lines go to
`session-end-worker.log` in the plugin's state directory
(`~/.claude/plugins/data/<plugin id>/state/`, or
`$TMPDIR/flightdeck-plugin/` on a Claude Code without a plugin data
directory), an owner-only file
truncated past 256 KiB. Policy evaluation fails open: with no cached
policy, tool calls proceed as Claude Code would normally decide, and MCP
servers bundled with other plugins are reported but not gated.

## Privacy

Everything the plugin captures goes only to the Flightdeck server you
configured, never to a third party. Turn either capture flag off to keep
content bodies on your machine; the session, tool names and token counts
still ship so the dashboard stays useful.
