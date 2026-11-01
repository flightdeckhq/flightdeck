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

## D219 -- A model call carries the effort it ran at; Claude Code's cost stays an estimate

**Date:** 2026-10-31
**Decision:** LLM events gain an optional `effort` string (the reasoning
effort a coding agent ran the call at, such as Claude Code's `low` to
`max`), bounded like `service_tier`. The Claude Code plugin sends it and
the call's `requestId` (`provider_metadata.request_id`), and no
`cost_reported`.
**Why:** effort drives a call's output length and so its cost, and it is
on every Claude Code transcript turn. Claude Code's own cost appears in
the transcript only as occasional cumulative session totals, so a
per-call figure cannot be derived from it.
**Rejected alternative:** spreading the cumulative `cost-state` totals
over the calls between snapshots; a session-level reported total (list
price even on a subscription).

## D220 -- The Claude Code plugin enforces when the user turns it on

**Date:** 2026-10-31
**Decision:** with the plugin option `enforcement` (or
`FLIGHTDECK_ENFORCEMENT=1`) the plugin is directive-capable: it applies
`shutdown` and token-budget directives through synchronous `PreToolUse`
and `UserPromptSubmit` gates (deny with `continue: false`, block the
prompt) and says so with `context.supports_directives=true`. Off by
default; a `degrade` is advisory; the gate fails open and keeps a stop
it already received.
**Why:** stopping a coding agent mid-session and holding it to a token
budget is the control Flightdeck offers other agents. A synchronous gate
on every tool call costs about 0.2 s, which not every developer wants.
**Rejected alternative:** gating every tool for every user (the latency
for everyone); gating prompts and MCP calls only (a stop would wait for
the next prompt); failing closed (a server outage stops every developer).

## D221 -- A Claude Agent SDK run is its own session, keyed by its Claude Code session id

**Date:** 2026-10-31
**Decision:** the sensor's Agent SDK interceptor reports each `query()`
call or `ClaudeSDKClient` connection as a session whose id is the
Claude Code session id from the SDK's `init` message, under a
`claude_agent_sdk` agent, from the SDK's message stream. It sets
`FLIGHTDECK_SDK_OBSERVED=1` for the CLI, and the Claude Code plugin then
sends nothing but its MCP gate. The sensor applies a directive only to
its own session and that session's sub-agent children.
**Why:** the CLI calls the model itself, so no provider patch sees the
run; under `setting_sources=[]`, the production setting, no plugin loads
either. The Claude Code session id joins the run to its transcript.
**Rejected alternative:** a child session of the sensor's session (an
SDK run is a different agent, by `client_type`); the plugin alone (dark
under `setting_sources=[]`, and labelled a coding session).


## D222 -- A Claude Agent SDK run is controlled through the SDK's hook callbacks

**Date:** 2026-11-01
**Decision:** the Agent SDK interceptor adds `PreToolUse` and
`UserPromptSubmit` callbacks to the run's options, after the caller's
hooks. They apply the run's directives (stop, warn, advisory degrade,
as the Claude Code plugin does) and the MCP Protection Policy, so the
run sets `supports_directives=true`. The sensor's event queue routes a
directive to the run its event belongs to. The plugin, which D221 left
running its MCP gate in an observed run, now does nothing in one.
**Why:** a `PreToolUse` deny is honoured under every permission mode and
needs no process per call; the run's session is the one the dashboard
stops, so the run's own callbacks must answer for it.
**Rejected alternative:** `can_use_tool` (one per run, so it would
replace the caller's); the plugin's gates (absent under
`setting_sources=[]`); `ClaudeSDKClient.interrupt()` for a stop (no
handle for a `query()` run, and the deny already ends the turn).

## D223 -- The worker processes a session's events in stream order

**Date:** 2026-11-01
**Decision:** the NATS consumer fetches with one goroutine and queues
each message on one of the pool's lanes by a hash of its session_id;
a lane processes its queue one at a time, under a processing deadline,
while queued messages are kept in progress. A session's events are
handled in stream order, sessions run in parallel across lanes.
**Why:** each goroutine fetched on its own, so a session's pre_call
could run before its session_start: the row was created without its
capture posture and the call's content dropped. Redelivery and
sequence rules had patched each such ordering as it surfaced.
**Rejected alternative:** redelivering a content event until its
session's posture is known (a delayed event lands after session_end
and is skipped with its tokens); more retries and stub rows per race.

## D224 -- OTLP ingest maps Claude Code's log records; content is opt-in

**Date:** 2026-11-01
**Decision:** ingestion accepts OTLP/HTTP (protobuf and JSON, gzip) and
maps the Claude Code dialect's log records to observe-only `claude_code`
sessions keyed by UUID5 of `session.id`, sub-agents as child sessions
ended by `subagent_completed`. Other dialects, spans and metrics are
counted as rejected; a session the plugin or the Agent SDK reports is not
reported again. Billing defaults to `subscription`, content to off; the
exporter's resource attributes override both.
**Why:** OTLP reaches runs no hook or SDK patch sees, with cost and TTFT.
**Rejected alternative:** spans first (no cost); a server-side capture
policy (none exists, capture stays client-declared); `client_type=otlp`
for Claude Code (loses its defaults); OTLP as enrichment of plugin
sessions; a new `close_reason` (aging already closes them).

## D225 -- Ingestion and the query API accept their public path prefix

**Date:** 2026-11-01
**Decision:** ingestion serves its routes both bare and under `/ingest`,
the query API both bare and under `/api`. The Helm chart's Ingress
forwards `/ingest/...` and `/api/...` unchanged; the compose nginx keeps
stripping the prefix.
**Why:** the chart's Ingress had no rewrite, so every ingest and API call
behind it reached a service that only serves `/v1/...` and got 404. The
chart's `ingress.className` is the operator's choice, and the services
are the one place that works under every controller.
**Rejected alternative:** a rewrite annotation in the chart
(`nginx.ingress.kubernetes.io/rewrite-target` with a capture group): it
is ingress-nginx only, Traefik and the cloud controllers each need their
own form, and regex paths are not portable `pathType: Prefix`. Moving
the routes to `/ingest/v1/...` only would break every client of the
bare paths.

## D226 -- The compose nginx forwards /api and /ingest paths unchanged

**Date:** 2026-11-01
**Decision:** supersedes D225's compose clause: the compose nginx (dev
and prod configs) and the vite dev proxy forward `/api/...` and
`/ingest/...` as sent, as the Helm chart's Ingress does, and the
services strip their prefix.
**Why:** a redirect a service builds from the request as received
(http-swagger reads `RequestURI`) loses a prefix the proxy stripped, so
`/api/docs/` landed on `/docs/index.html`, the dashboard. Forwarding the
path unchanged also sends the services the same path under every
deployment.
**Rejected alternative:** keep stripping in nginx and special-case the
Swagger redirect (one proxy-specific rule per redirecting handler, and
compose would still differ from the chart).

## D227 -- A provider-hosted MCP call's tool_call names its server as server_name

**Date:** 2026-11-01
**Decision:** the sensor's `tool_call` for an OpenAI Responses `mcp_call`
item carries the item's `server_label` as top-level `server_name`, cut
at 256 characters. The event stays a `tool_call`; `server_name` is
metadata and ships with capture off.
**Why:** `server_name` is how every MCP event, the plugin and OTLP name
an MCP server, and the worker projects it and the Events filter reads it
for any event type, so the call is found by server with no new column.
**Rejected alternative:** a `server_label` field (a second name for the
same thing, read by nothing); emitting `mcp_tool_call` (OpenAI's servers
made the call, not the agent's MCP client: no transport, fingerprint or
MCP policy decision applies).

## D228 -- An OpenAI Responses request is stored as instructions and input

**Date:** 2026-11-01
**Decision:** under `capture_prompts`, a Responses call's content stores
`instructions` in `system` and `input` verbatim in `input` (a string or
the input item list, SDK objects dumped as the JSON the SDK sends);
`messages` stays empty.
**Why:** nothing of the Responses request was stored. `input` is the
API's own parameter name and already a JSONB column (embeddings), and
`instructions` is the top-level system text Anthropic's `system` holds.
**Rejected alternative:** rewriting `instructions` and `input` into a
chat `messages` array (normalising one provider's shape into another's,
which content capture never does); a new column (no reader needs one).

## D230 -- A litellm text_completion stores its prompt verbatim in input

**Date:** 2026-11-01
**Decision:** under `capture_prompts`, a `litellm.text_completion` /
`atext_completion` call's content stores the request's `prompt` (a
string, a list of strings or token ids) verbatim in `input`; `messages`
and `system` stay empty. A `litellm.responses` call is stored as D228
stores an OpenAI Responses call.
**Why:** the legacy completion API has no `messages`; `input` is the
existing slot for a request's single non-chat input, stored as sent.
**Rejected alternative:** a synthesized `[{"role": "user", "content":
prompt}]` in `messages` (what litellm sends underneath, but not what the
caller sent; content capture stores the caller's request); a new
`prompt` field (a contract change no reader needs).

## D231 -- Each litellm call is reported by the entry point the caller used

**Date:** 2026-11-01
**Decision:** every patched litellm entry point (`completion`,
`text_completion`, `responses`, `embedding` and their async forms) runs
under the outer-call mark and passes a call through untouched when the
mark is already set, so litellm calling its own entry points (or the
OpenAI SDK) underneath is reported once, in the caller's entry point's
shape.
**Why:** `text_completion` calls `completion`; `responses` bridges
through `litellm.completion` on providers without a native Responses API.
**Rejected alternative:** patching `litellm.main.completion` so the
`completion` wrapper reports `text_completion` (every `acompletion`
calls it too and would enter the sensor twice, and the call would be
reported in the chat shape, not the one the caller got back).
