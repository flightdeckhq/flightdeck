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

## What it reports

- Tool calls (PreToolUse, PostToolUse) → appears as pre_call and tool_call events
- Session end (Stop) → appears as session_end event
- All sessions appear with `agent_type=developer` and `flavor=claude-code`

## Privacy

No prompt content is captured. Only tool names and event types are reported.
Token counts are not available from Claude Code hooks and are reported as 0.
