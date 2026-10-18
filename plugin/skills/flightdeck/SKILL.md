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
- Every tool call by name, with a sanitised whitelist of arguments
  (`file_path`, `command`, `query`, `pattern`, `prompt`) while
  `FLIGHTDECK_CAPTURE_TOOL_INPUTS` is on. MCP tool calls carry their full
  arguments because the whitelist would empty them.
- Every LLM turn read from the session transcript: model, input and output
  tokens, cache tokens, latency, and the prompt and response bodies while
  `FLIGHTDECK_CAPTURE_PROMPTS` is on.
- Context compaction and the MCP servers declared in `.mcp.json`.
- MCP policy decisions: when a server is warned or blocked by the
  Flightdeck MCP policy for this flavor, the session emits a
  `policy_mcp_warn` or `policy_mcp_block` event.

Prompt capture is on by default for this plugin because you are observing
your own session on your own machine. The Python sensor used for
production agents defaults the other way.

## Where the session shows up

Open the dashboard served by `FLIGHTDECK_SERVER` (default
`http://localhost:4000`). The session is stamped with:

- flavor `claude-code`
- agent type `coding`
- client type `claude_code`

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

## Environment variables

| Variable | Default | Effect |
| --- | --- | --- |
| `FLIGHTDECK_SERVER` | `http://localhost:4000` | Control plane base URL; events go to `/ingest`, policies come from `/api`. |
| `FLIGHTDECK_TOKEN` | `tok_dev` | Access token. The default is the development seed token and prints a warning; set a real token outside local development. |
| `FLIGHTDECK_CAPTURE_PROMPTS` | `true` | `false` strips prompt, response and tool-result bodies while keeping metadata and token counts. |
| `FLIGHTDECK_CAPTURE_TOOL_INPUTS` | `true` | `false` strips the sanitised tool arguments. |
| `FLIGHTDECK_QUIET` | unset | `1` silences the default-token warning. |
| `CLAUDE_SESSION_ID` | unset | Forces the session id reported to Flightdeck. |

## Failure behaviour

The plugin never blocks Claude Code. If the server is unreachable it
prints one line to stderr per failed request and exits successfully, and
the next hook tries again. Policy evaluation fails open: with no cached
policy, tool calls proceed as Claude Code would normally decide.

## Privacy

Everything the plugin captures goes only to the Flightdeck server you
configured, never to a third party. Turn either capture flag off to keep
content bodies on your machine; the session, tool names and token counts
still ship so the dashboard stays useful.
