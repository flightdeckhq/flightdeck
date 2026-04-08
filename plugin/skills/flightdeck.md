# Flightdeck

Flightdeck is the control plane for your AI agent fleet. When you are running a Claude Code session with the Flightdeck plugin installed, your session appears in the Flightdeck fleet view alongside production agents.

## What is being tracked

Flightdeck tracks:
- Every tool call you make (Read, Write, Bash, Edit, etc.)
- Session start and end
- Tool names only -- not file contents, not command outputs, not prompt content

No prompt content is ever captured by the plugin. Only tool names and event types are reported.

## Viewing your session

Open the Flightdeck dashboard at the server configured in FLIGHTDECK_SERVER. Your session appears with:
  AGENT_FLAVOR=claude-code
  AGENT_TYPE=developer

Use the Developer filter toggle in the fleet view to show only developer sessions.

## Environment variables

FLIGHTDECK_SERVER -- the Flightdeck control plane URL (required)
FLIGHTDECK_TOKEN -- your enrollment token (required)

If either variable is missing, the plugin does nothing and Claude Code is not affected.

## Privacy

The plugin never reads file contents, command outputs, or any prompt content. It reports tool names and lifecycle events only. All data goes to the Flightdeck server you configured -- not to any third party.
