# Flightdeck Decisions

The decisions a future contributor needs before changing the system:
why a contract, a schema or a trust boundary is shaped the way it is,
and which alternative was rejected so nobody proposes it again.

Record a decision here when it:

- changes a contract: the event payload, an API request or response,
  a wire or file format;
- changes the database schema;
- moves a trust or security boundary (authentication, what is stored,
  what crosses a network); or
- rejects an alternative a future contributor would plausibly propose
  again.

Everything else (implementation choices, plan changes, review notes,
bug write-ups) goes in the PR description and commit body, where `git
log` keeps it next to the change.

Each entry is 10 to 15 lines:

```
## D<next> -- <the decision, as a sentence>

**Date:** YYYY-MM-DD
**Decision:** what the system does.
**Why:** the constraint or evidence that made it the right call.
**Rejected alternative:** what was considered and why it lost.
```

Decisions D001 to D213 are in [DECISIONS-ARCHIVE.md](DECISIONS-ARCHIVE.md),
frozen on 2026-10-27; D-numbers cited in CHANGELOG.md, migrations and
PR history resolve there. Numbering continues from D214. Entries are
never edited once merged: a reversal or an extension is a new entry that
names the one it supersedes in its **Decision** line.

## D214 -- client_type is a registry of nine values with per-type defaults

**Date:** 2026-10-27
**Decision:** `client_type` accepts nine values (ARCHITECTURE, "Client
type registry"), registered before most have an emitter, each with a
label, an expected `agent_type` and defaults for `supports_directives`,
`billing_mode` and tool-error redaction. `contracts/client_types.json`
is the source; parity tests pin every copy. Supersedes D166's flags and
D167's "not described until shipped" clause; narrows D109's Claude Code
fallback to rows with no `client_type`.
**Why:** each integration needs its own value, and the literal sat in a
dozen places; one migration for all nine beats one per integration.
**Rejected alternative:** reusing `flightdeck_sensor` with `framework`
(every query would branch on it); a value per integration as it lands;
a `client_types` reference table (ingestion, the worker and the
dashboard need the defaults too, so it would be one more copy).

## D215 -- The worker, not the plugin's markers, guarantees a call is stored once

**Date:** 2026-10-27
**Decision:** the Claude Code plugin's `post_call` id is
`uuid5(NAMESPACE_FLIGHTDECK, "flightdeck://claude-code/post_call/<message
id>")`, and the worker drops any event whose client-supplied id is
already stored before it adds tokens or touches a session.
**Why:** the plugin's sent-markers live in `$TMPDIR`, which reboots
clear, so a resumed conversation re-sent its history (a quarter of all
Claude Code tokens on one dev box). The first copy stored keeps its
session and billing mode.
**Rejected alternative:** moving the markers to a durable directory
(still per machine, so a replayed or copied transcript or a second
machine still re-sends; the worker check covers every source); a
`message_id` column with a unique index (the event id already carries
the identity, and `events` is keyed on `(id, occurred_at)`).

## D216 -- Clients cut captured content to fit the 1 MiB event limit

**Date:** 2026-10-29
**Decision:** The Claude Code plugin and the Python sensor send no
event body over 768 KiB.
An event over it has the strings of its captured `content` cut, all to
the same largest length that fits, each ending in a visible marker;
when no cut fits, the event is sent without content. Token counts and
metadata are never cut.
**Why:** Ingestion reads 1 MiB of a body and NATS carries 1 MiB per
message, so a larger event was rejected (413 or 400) and its tokens
lost.
13 of 5,332 turns in one dev box's transcripts crossed it.
**Rejected alternative:** raising the ingestion and NATS limits (a long
enough prompt crosses any limit, and the limit bounds how much one
request makes ingestion buffer); dropping the content of an oversized
event outright (loses the part that fits).

## D217 -- A remembered MCP approval records the session's permission mode

**Date:** 2026-10-29
**Decision:** `mcp_policy_user_remembered` carries an optional
`permission_mode`, Claude Code's mode when the approved call ran,
passed through as sent and bounded to 64 characters; ingestion rejects
a non-string or longer value. The plugin records the approval in every
mode.
**Why:** an operator reviewing approvals wants to know whether one was
given in `bypassPermissions` or `auto`. The mode does not change what
the approval means: Claude Code refused a call the plugin's
`PreToolUse` answered `ask` in all of `default`, `acceptEdits`, `auto`
and `bypassPermissions` (2.1.312, `claude -p`), so a call that then
succeeded was approved at a prompt.
**Rejected alternative:** not remembering approvals made in
`bypassPermissions` or `auto`, on the theory that no one was asked
(the probe shows someone always is).

## D218 -- Hook signals are one event type, session_signal, named by `signal`

**Date:** 2026-10-30
**Decision:** a session change that is not a model call, tool call or
policy decision (compaction, model switch, and the notification,
permission, worktree and config hooks to come) is a `session_signal`
event with an open, form-checked `signal` name and a bounded,
metadata-only `signal_data` object; its text is content, sent only
under capture. It replaces the synthetic `tool_call` named
`compact_context` that marked a compaction.
**Why:** Claude Code has some twenty such hooks; one type lets each new
one reach the dashboard with a signal name instead of changes to
ingestion, the workers and the dashboard's type lists. A compaction is
not a tool call, and counting it as one inflated tool-call counts.
**Rejected alternative:** an event type per hook (each one touches every
component); keeping `compact_context` beside the new signal (a
compaction would show twice).

