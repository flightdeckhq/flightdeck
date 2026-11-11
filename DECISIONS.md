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

## D229 -- OTLP ingest refuses rather than guesses on a bad billing mode or a failed session read

**Date:** 2026-11-01
**Decision:** extends D224. A `flightdeck.billing_mode` outside
`metered`, `subscription` and `local` fails validation for the
session's model calls, named in `partial_success`. A session read that
fails or passes its deadline answers the whole request 503 with
`Retry-After`, publishing and charging nothing.
**Why:** the billing mode decides whether Claude Code's reported cost
counts toward `estimated_cost`, so a typo must be visible. Without the
read the receiver cannot know whether to start the session or whether
the plugin already reports it; event ids are deterministic, so the
exporter's retry is safe.
**Rejected alternative:** defaulting a bad billing mode to
`subscription` (hides the mistake, can mis-bill a metered fleet);
publishing despite a failed read (rows with no capture posture or
context, and possible duplicates of plugin sessions).

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
**Decision:** a nested litellm call passes through only when the outer
mark is set and its caller re-issues the caller's own call (the
responses/completion bridges, the fallback loop): one report, with the
model that answered. A failed fallback attempt gets no `llm_error`; a
non-streamed one the provider billed before failing (a timeout, a
`post_call_rules` rejection) goes unreported. DEGRADE drops a call's
`fallbacks` and `context_window_fallback_dict`.
**Why:** those re-issue the same call; other nested calls are billed on
their own. The degrade target is the only model the policy allows; a
provider's own server-side routing (OpenRouter `models`) is not dropped.
**Rejected alternative:** a broad pass-through (hides billed calls);
reporting each fallback attempt (the loop swallows a policy block).

## D232 -- The dashboard names a session's source from `context.telemetry`; agent rows carry their latest session's telemetry

**Date:** 2026-11-01
**Decision:** a session reported over OTLP (`context.telemetry=otlp`)
shows an `OTEL` pill beside its client pill and "via OpenTelemetry" in
its run drawer; the plugin's reads "via plugin". `GET /v1/fleet`,
`GET /v1/agents` and the agent hits of `GET /v1/search` add `telemetry`,
the latest session's value, to the runtime-context projection; search
session hits add `client_type`.
**Why:** an OTLP session observes only, so its source decides what the
operator can do; agent rows carry no session context to read it from.
**Rejected alternative:** a `client_type` per source (D224 kept
`claude_code` for its defaults); reading it from loaded sessions'
context (the fleet's per-agent sessions omit context, so rows outside
the paginated window would lose the pill); a pill on every source
(noise on the default plugin and sensor rows).

## D233 -- Custom directives are offered only to client types that run custom handlers

**Date:** 2026-11-01
**Decision:** extends D214: the client type registry gains
`runs_custom_directives` (`true` for `flightdeck_sensor` only). The dashboard offers custom
directives (the run drawer's Directives tab, the Fleet trigger) on a
session that supports directives and whose type runs them; Stop stays
gated on `supports_directives` alone.
**Why:** the enforcement-on Claude Code plugin and the Agent SDK
interceptor take stop and budget directives but answer a custom one
with an error result, so offering one was a dead end.
**Rejected alternative:** gating on `supports_directives` (offers the
dead end); a `client_type` string compare in the dashboard (a new
client that runs handlers would need a code change, not a registry
row).

## D234 -- Fleet's agent-row controls are scoped to the agent and fanned out by the API

**Date:** 2026-11-02
**Decision:** extends D058: `POST /v1/directives` accepts `agent_id`
for `shutdown` and `custom`. The API sends one row to each live run of the agent that
can act on it, in one transaction, and returns the count in
`X-Directive-Count`. Fleet's Stop All and its directive trigger use it.
**Why:** a sidebar row is an agent. The dashboard holds only some of an
agent's runs (its five newest and the last day's page), so enumerating
in the browser left live runs running while the dialog said "All".
**Rejected alternative:** `shutdown_flavor` from the agent row (reaches
other agents' runs sharing the flavor); sending one directive per
session the browser holds (misses runs it has not loaded); a new
`/v1/agents/{id}/directives` route (a second way to create a directive).

## D235 -- Directive fan-outs are all-or-nothing; a custom directive's session_id wins over its flavor

**Date:** 2026-11-02
**Decision:** extends D058: every fan-out, by agent or by flavor,
inserts its rows in one transaction, so a failed insert answers 500 with
nothing written. A `custom` directive that carries `session_id` goes to
that session only; a `flavor` beside it only narrows the fingerprint
check.
**Why:** a 201 for a partial set left the operator believing every run
was reached; the Directives page's "Specific run" sends both fields and
was reaching every run of the flavor.
**Rejected alternative:** logging a failed row and answering 201 with the
rest (a silent partial stop); answering the `session_id` + `flavor` pair
with 400 (breaks the Directives page's "Specific run").

## D236 -- A Claude Code turn is retried and sent only under its own session; a resumed sub-agent re-attaches its child

**Date:** 2026-11-02
**Decision:** extends D215, narrowing its whole-transcript recovery. A
turn whose POST failed is sent by a later hook (sub-agent ends too); a
flush sends only turns that ran while its session was current, so one
unsent when its session ends is dropped, never misfiled. A sub-agent's
child, `uuid5(outer session, agent_id)`, is re-attached on each resume.
**Why:** one conversation lost 26 calls (7.63M tokens), 24 of them after
a failed send that was never retried; a re-read after lost markers filed
5 under a later coordinator's child; a resumed child stayed closed.
**Rejected alternative:** late delivery to the old run (changes D212;
pre-0.7.1 plugins' random-id re-sends would count twice); a child keyed
on Claude Code's session id (contradicts D190); a child per resume.

## D237 -- A Claude Code tool event's id comes from its tool_use_id; a failed one is rebuilt from the transcript

**Date:** 2026-11-02
**Decision:** extends D236. The plugin's `tool_call` and `mcp_tool_call`
carry `uuid5(NAMESPACE_FLIGHTDECK, "flightdeck://claude-code/tool_call/<tool_use_id>")`.
A hook records the event as owed before its POST, with only what it
alone knows; after a failed POST a later flush of its session rebuilds
it from that and the transcript, and the worker stores it once (D215).
**Why:** a tool event was sent once with a server-made id, so a failed
POST lost it for good (5 in the forensic conversation) and a re-send
would have stored it twice.
**Rejected alternative:** keeping the hook's payload on disk (puts tool
output in the state directory, which holds no content); rebuilding
every transcript tool use (reports uses no hook reports, such as denied
permissions, and races the hook for the first copy).

## D238 -- A record dated after a closed OTLP sub-agent's end resumes it

**Date:** 2026-11-02
**Decision:** extends D224. A record of a closed sub-agent dated more
than a second after its end (its latest `session_end`, on Claude Code's
clock, unless a later `session_start` is stored: then `ended_at`) gets
a synthetic `session_start` through the attach path, reopening the
row; one dated at or before it, or not dated, starts nothing. Every
request reads its sub-agents' ends.
**Why:** a `SendMessage` resume runs the sub-agent again under its
`agent_id` after `subagent_completed`; its records landed on the closed
row and its tokens were missing from `tokens_used`.
**Rejected alternative:** never restarting a closed sub-agent (loses a
resumed run's tokens); restarting on any record (a late async record
reopens a finished sub-agent); `ended_at` alone (the worker's clock, an
export interval late); trusting the replica cache (another replica may
have published the end).

## D239 -- A SIGTERM / SIGINT handler ends the session on the drain thread and takes no lock

**Date:** 2026-11-02
**Decision:** the sensor's signal handler claims the end of the session
without waiting, hands it to the existing event-queue drain thread, polls
up to 2 s, then passes the signal on; for the default action before
`session_end` is out, the drain thread re-delivers it once it is, by 8 s
after the signal (10.5 s if an event's POST was under way: its retry is
skipped, each shutdown POST is one attempt, and a lock the interrupted
code may hold is waited for 0.5 s at most). A second signal is passed on
at once; an ignored one is left alone.
**Why:** the handler runs on the interrupted frame, which can hold the
session, policy or queue lock (not re-entrant; on Python 3.13 maybe for
good), so `end()` there deadlocked; sensor rule 32 allows no other thread.
**Rejected alternative:** `end()` in the handler (the deadlock); a helper
thread per signal (rule 32; `Thread.start()` takes a lock the interrupted
frame can hold); exiting once the wait runs out (drops a slow session_end).

## D240 -- patch() patches each SDK when the application first imports it

**Date:** 2026-11-02
**Decision:** `import flightdeck_sensor`, `init()` and `patch()` import no
SDK. `patch()` patches an SDK already imported at once, and the others
from a `sys.meta_path` finder that wraps the loader of the seven modules
it covers and patches right after the module runs. The import hook never
waits for the patch lock: it queues the SDK for the thread that holds it.
**Why:** importing every installed SDK cost seconds at startup and made
litellm fetch its price list from GitHub in applications that never used
litellm.
**Rejected alternative:** wrapt's post-import hooks (a runtime
dependency for a sensor that needs only pydantic); replacing
`sys.modules` with a dict that watches writes (touches every import in
the process); the hook waiting for the patch lock (deadlocks against a
`patch()` waiting for that same import).

## D241 -- The worker notifies flightdeck_fleet of every session state change it makes

**Date:** 2026-11-02
**Decision:** the reconciler's stale and lost marks, the reaper's close
and a parent revived by its child each notify `flightdeck_fleet` once
committed, one session per payload (empty event fields for a state-only
change, the synthetic `session_end` for a reaped close). Every hub
broadcast also carries the agent's rolled-up `agent_state`, which the
dashboard shows as the agent's badge.
**Why:** only event writes notified, so a run that died with Fleet open
stayed active in the browser until reload.
**Rejected alternative:** the dashboard applying the worker's thresholds
(a second copy of its constants); one notification per batch (the hub
reads one session per payload); rolling the badge up from the runs a
page loaded (a page holds only an agent's newest runs and last day's).

## D242 -- Events page in (occurred_at, id) order; the keyset cursor names its row

**Date:** 2026-11-02
**Decision:** `GET /v1/events` and `GET /v1/sessions/:id` order events
by `occurred_at`, then `id`, in the requested direction. An optional
`before_id`, the id of the row at the `before` cursor, returns the rows
strictly before that row in this order; `before` alone is unchanged.
**Why:** events often share a timestamp (whole-second client stamps,
the reaper's `session_end` rows sharing one `NOW()`), so ordering by
time alone let an offset page skip or repeat a tied row, and a
timestamp cursor dropped every row tied with the cursor.
**Rejected alternative:** an opaque cursor token (a second paging
contract, and offset pages still need the tiebreaker); paging by a new
sequence or UUIDv7 column (a migration and backfill of every event, and
it orders by arrival, not by the event time the views sort by).

## D243 -- Concurrent runs of one agent split its swimlane row into lanes

**Date:** 2026-11-02
**Decision:** extends D157: one row, one label, 48 px per agent. While runs
overlap in the window the row splits into up to four lanes of circles,
glyphs and a run line; tracks past the fourth share the fourth. A run's
lane is its track (the lowest free at its start whose last segment ended
within one window span) ranked among the tracks in view: sequential runs
share a lane, lanes below move up when a track leaves the window, and a
resumed run's segments may sit in different lanes. No overlap: one line.
**Why:** Claude Code fans out same-role sub-agents (four were seen open at
once), more than two edges can separate; Agent SDK sub-agents stay one run.
**Rejected alternative:** per-run sub-rows or a growing row (D157); a
per-spawn identity (reverses D115, D126); hover-only linking; a 3-lane cap.

## D244 -- Ingestion stores an unknown stream outcome, abort reason or llm_error type as `other` and refuses a negative stream count

**Date:** 2026-11-02
**Decision:** a `streaming.final_outcome`, a `streaming` or `llm_error`
`abort_reason`, or an `llm_error` `error.error_type` outside its
vocabulary is stored as `other`, counted and logged at most once a
second. A wrong type, a non-object `streaming` or `llm_error` `error`, a
negative or fractional `partial_*` or `chunk_count` and a negative
stream timing answer 400, as a negative `tokens_*` does.
**Why:** these are diagnostics a newer client can extend (`other` is the
taxonomy's own fallback), and a 400 would also drop the event's tokens.
A negative count comes from a broken client and would subtract from
totals. Tests pin the taxonomy to every first-party emitter.
**Rejected alternative:** a 400 for an unknown value, as `estimated_via`
and `close_reason` get (drops billed tokens whenever a client is ahead of
the server); storing it as sent (readers meet undocumented values).

## D245 -- A failed stream's billed tokens are stored as its llm_error's token columns and count in every total

**Date:** 2026-11-02
**Decision:** the worker copies an `llm_error`'s `error.partial_tokens_*`
into its `tokens_input` / `tokens_output` / `tokens_total` (when the event
sends no top-level counts). The sensor stamps the call's `billing_mode` on
it; one without (an older sensor) takes the session's latest `post_call`'s,
else the client type's default. Session and agent counters,
the `tokens` metric, `estimated_cost` and the agent summary count those
rows (no backfill); `tokens` and the summary count `embeddings` too.
**Why:** one stored value every reader already sums, the dashboard's
client-side sums included; a failed stream sends no `post_call`. No
recorded reason kept embeddings out of `tokens`.
**Rejected alternative:** reading the payload at query time (every query
parses JSON, and analytics would count old rows the stored counters
never will); a backfill migration (it would add tokens the live rules
skip, such as a call published after its session ended).

## D246 -- OTLP GenAI spans are staged in Postgres and assembled per trace

**Date:** 2026-11-04
**Decision:** extends D224 to Pydantic AI, Strands, OpenAI Agents and
ADK: ingestion stages their spans in Postgres, answering 200 after the
commit; captured content is staged only when declared and deleted on
assembly, the one exception to content living only in `event_content`.
Every ingestion process leases due traces and publishes ordinary events:
each named `invoke_agent` span a session, hand-offs sibling roots, tokens
from the outermost model span, `client_type=otlp`, `provider=otel_genai`;
the worker dates these sessions from their events.
**Why:** spans export when they end, so an agent's span arrives after its
calls, at any replica; session identity, parent and capture are write-once.
**Rejected alternative:** per-replica buffers with a peer ring (a crash
loses 200-acked data); emit-then-reattribute (moves stored events, adds
event types old workers drop); assembly in the worker (a second copy of
the validator); any `gen_ai` scope by operation name (Claude Code's match).

## D247 -- Each staged GenAI record records the assembly that marked it

**Date:** 2026-11-04
**Decision:** `otlp_spans.assembled_in` holds the number of the assembly
that marked a record (the trace's `assembly_count` after it), NULL exactly
while unassembled. An already published agent takes as its parent only an
agent ancestor assembled in the same assembly or an earlier one, so a late
ancestor never re-parents it, in its arrival assembly or any later one.
**Why:** identity, parent and role are written once; without the number, an
ancestor assembled after the agent cannot be told from one assembled with
it once both are marked, and a third assembly re-parented the agent.
**Rejected alternative:** persisting each published session's identity on
the trace row (a second copy of what the mapping derives, kept in step on
every assembly); a stateless rule ignoring unassembled ancestors (holds
only until the ancestor is itself assembled).

## D248 -- The session detail API carries the session's stored capture posture

**Date:** 2026-11-05
**Decision:** `GET /v1/sessions/:id` returns `capture_prompts`, the
`sessions.capture_prompts` column as stored (`true`, `false`, or `null`
before a `session_start` declared it). The Prompts tab keys its disabled
state on it: off or null shows the capture-disabled message; on with no
stored content says the run recorded none.
**Why:** a capture-on OpenTelemetry GenAI run whose framework sent no
content stores no `event_content` row, so a dashboard reading only
whether content exists told the operator capture was off when it was on.
**Rejected alternative:** inferring the posture from `capture_enabled`
(whether any event stored content), which cannot tell capture-off from
capture-on-but-empty.

## D249 -- The worker refuses a malformed session_id at the consumer and caps payload strings in its logs

**Date:** 2026-11-05
**Decision:** the worker's fetch loop terminates, on its first delivery,
an event whose `session_id` is not a canonical UUID, counts it as
`invalid_session_id` and logs it once with the id capped at 64 bytes.
Payload strings in the worker's log lines go through named caps
(`workers/internal/logcap`): ids and the event type at 64 bytes, names at
256, error text at 1 KiB.
**Why:** NATS is a trust boundary of its own; a direct publisher skips
ingestion's validator, and a bad id then failed its `::uuid` cast three
times, logging the whole id (up to NATS's 1 MiB payload) each time.
**Rejected alternative:** re-running ingestion's full validator in the
worker (two copies of the contract that drift apart), and a log handler
that truncates every attribute (it replaces slog's default output format,
which the integration tests and operators read).

## D250 -- The OpenAI patch hooks resources the client builds in its constructor, and the openai floor is 1.26

**Date:** 2026-11-07
**Decision:** on openai before 1.78, whose client assigns `self.chat =
Chat(self)` in `__init__`, the class patch installs a data descriptor for
each resource the client class annotates; it keeps the SDK's resource in
the instance `__dict__` and hands out the sensor proxy while a session is
active. The `openai` extra requires `openai>=1.26`; below it the
interceptor patches nothing and warns once at import. CI tests 1.26.0.
**Why:** the sensor declared `openai>=1.0` while every call on 1.0 to
1.77 went unmetered. 1.26 is the first release whose chat `create` takes
`stream_options`, which the sensor adds to every streamed chat call; on
an older SDK that call raises `TypeError` in the caller's code.
**Rejected alternative:** raising the floor to 1.78 (drops the year of
releases from May 2024 to May 2025, when the hook is small and tested in
CI); keeping 1.0 and skipping `stream_options` there (streamed calls
would report no usage, so they could not be metered).

## D251 -- A failed tool_call counts on every per-session and per-agent error count, and a plugin MCP server's flattened key reads as its colon key

**Date:** 2026-11-07
**Decision:** an error event is an `llm_error` or a `tool_call` whose
`payload.error` is an object, one predicate for `error_types[]`, the
`error_type` filter and the agent summary's `errors`; a failed
`mcp_tool_call` stays on `mcp_error_types[]`. The `mcp_server` facet
reads `plugin_<plugin>_<server>` as `plugin:<plugin>:<server>`, and a
filter on the colon key matches both. Extends D190.
**Why:** a plugin tool failure is stored as a `tool_call` with an error
block (D190), so counting only `llm_error` hid it from those counts.
**Rejected alternative:** a migration rewriting the old key (it edits
stored events, and an older plugin still posting recreates them);
counting MCP failures in `errors` (JSON-RPC taxonomy, not the LLM one).

## D252 -- The Prompts view tells a Responses call and a legacy completion by the stored response's `object`

**Date:** 2026-11-07
**Decision:** `PromptViewer` renders a call's stored `input` as a
Responses request (`instructions`, input items) when the stored response's
`object` is `"response"`, and as a legacy completion's `prompt` when it is
`"text_completion"`. Without either (a stream that stored no response
snapshot), the input is not shown there.
**Why:** the provider sets `object` on every response it returns, so the
marker is already in every stored row. The content's shape alone (no
`messages`, an `input`) is shared with embeddings calls, and the viewer
gets only the event id.
**Rejected alternative:** a sensor-stamped `api` field in the content
envelope (a contract change that leaves every stored row unmarked);
guessing from the shape of `input` (an embeddings call's string list
would render as a Responses input).

## D253 -- Ingestion owns the FLIGHTDECK stream and bounds it by age and size, discarding the oldest

**Date:** 2026-11-07
**Decision:** ingestion creates the stream, or updates it in place at
startup, with limits retention, discard-old, a max age (default 72 h),
a max size (default 5 GiB) and a replica count (1 in compose; under Helm
3 on a cluster of 3 or more servers). The workers only wait for it. An
update NATS refuses is logged and the stream is used as it is.
**Why:** the stream kept every event (1.4 GB on a dev stack in ten
weeks). Under limits retention a full stream holds processed messages,
so discard-new would refuse every publish once full. The cost: events
still unprocessed are lost when the workers are down past the age limit
or behind by more than the size limit.
**Rejected alternative:** interest or work-queue retention (a message
published before the workers' consumer exists is dropped at once);
discard-new (stops ingestion at steady state); both services
reconciling (they fight over settings across a version skew).

## D254 -- An omitted `to` leaves the sessions and events listings without an upper bound

**Date:** 2026-11-07
**Decision:** `GET /v1/sessions` and `GET /v1/events` bound `started_at` or
`occurred_at` from above only when the request carries `to`; a zero-time `to`
is a 400. The agent summary and `/v1/analytics` keep the API-clock end: they
are polled windowed aggregates, so a row dated ahead lands on the next poll.
**Why:** Postgres stamps `started_at`; `occurred_at` is the client's time,
accepted up to five minutes ahead. When the API's clock read behind, a fresh
session or event fell outside the range; a dev clock stepped back ~2 s every
few minutes emptied the state-sort integration test's listing.
**Rejected alternative:** defaulting `to` to Postgres's `NOW()` (it can still
read behind the client, and a stepped-back database drops its own rows); a
grace margin on the API's clock (a guessed bound a larger skew breaks).

## D255 -- The ingestion and query APIs time requests by route pattern and serve the histogram on a listener of their own

**Date:** 2026-11-07
**Decision:** (extends D198) both APIs record
`flightdeck_http_request_duration_seconds` by route pattern, bounded
method and status class, served at `GET /metrics` on an unauthenticated
port of their own (9103, 9104) that compose does not publish, nginx does
not route and Helm lists only on headless `-metrics` Services.
**Why:** the pattern keeps ids out of label values; a separate port keeps
an auth-free endpoint off the public edge, and the services stay free of
the Prometheus client library, as the workers are.
**Rejected alternative:** `/metrics` on the API port behind a token or an
nginx deny (one routing slip exposes it); raw paths as the label (a
series per session id); prometheus/client_golang (a dependency for one
family).

## D256 -- The sensor wraps a framework natively only where control or uncovered structure is at stake; OTLP covers observation

**Date:** 2026-11-07
**Decision:** a framework gets a native sensor wrap when it adds what the
OTLP GenAI path cannot: in-band enforcement per child, live events and no
exporter setup, or structure no mapped dialect reports. Native wraps: Google
ADK, OpenAI Agents SDK, Microsoft Agent Framework, LlamaIndex, Deep Agents.
Pydantic AI and Strands keep OTLP for structure (their SDK calls are metered
natively). Agno, Haystack, smolagents: labels only, demand-ranked (#278).
Gemini (google-genai) and Bedrock Converse are deferred (#276, #277; D178
stands); their PromptViewer branches are approved for that work.
**Why:** OTLP sessions are observe-only and appear after the run ends; the
SDK patches already meter every framework on Anthropic, OpenAI or litellm.
**Rejected alternative:** native wraps for every framework (patching risk
where OTLP already gives structure); OTLP only (no control, no live view).

## D257 -- The sensor's framework labels are the GenAI dialect's, `autogen` is Microsoft's line, and a framework imported after init() is detected later

**Date:** 2026-11-07
**Decision:** sensor framework labels match the OTLP GenAI dialect's; the
Agent SDK interceptor sends the bare `claude_agent_sdk`. The `autogen` import name
reports `ag2`; `autogen` means `autogen_agentchat` / `autogen_core`, or
AutoGen 0.2 (`pyautogen` < 0.3, `autogen-agentchat` < 0.4). While a
session's framework is unknown the sensor re-runs the classifiers when it
builds an event and `sys.modules` has grown; the worker fills a null
`sessions.framework` from a later event and appends the label to
`context.frameworks[]`. The analytics `framework` dimension groups by the
label before the `/`. Existing rows are not backfilled.
**Why:** the analytics dimension merges sensor and OTLP rows only on equal
labels, and one framework must not split by version or import order.
Under D240 an app importing its framework after `init()` was null.
**Rejected alternative:** importing frameworks at `init()` (D240's cost); a
scan per event; a second `session_start` (a re-attachment); a versioned
list on the wire (a payload change); a backfill (AG2/AutoGen is not stored).

## D258 -- The sensor reports a framework hand-off as the GenAI dialect's `agent_handoff` session_signal

**Date:** 2026-11-07
**Decision:** extends D218 and D246 to the sensor.
`Session.emit_agent_handoff` posts a `session_signal` with
`signal=agent_handoff` and `signal_data` `{from, to}` (agent names,
trimmed, cut to 256 bytes at a UTF-8 boundary, left out when unknown) on
the session of the agent handing off, with no model, tokens or content
under any capture setting. It posts synchronously, in one 2-second
attempt, so it reaches ingestion before a child's `session_end` without
holding the agent long. Ingestion, the worker and the dashboard are
unchanged.
**Why:** the ADK and OpenAI Agents wraps should store what the OTLP
receiver stores, so one hand-off reads the same from either source.
**Rejected alternative:** a dedicated `agent_handoff` event type (a second
shape for one fact); carrying the handed-over input as content (it is
already on the transfer's `tool_call` and the next call); posting through
the event queue (a child's synchronous `session_end` can overtake it).

## D259 -- The OpenAI Agents SDK wrap opens a child per agent, keeps model calls on the sensor's session, and reports guardrails as `guardrail_tripwire`

**Date:** 2026-11-07
**Decision:** corrects D256's "enforcement per child": the CrewAI,
LangGraph and OpenAI Agents wraps keep model, tool and MCP events on the
sensor's session, so enforcement is per session. The OpenAI Agents wrap
(`AgentRunner.run` / `run_streamed`, composite run hooks, the guardrails'
`run`) opens a child per agent, nests an agent used as a tool under its
caller's child, and stores the conversation id as
`context.gen_ai_conversation_id`. A fired guardrail posts the
`guardrail_tripwire` session_signal, `signal_data` `{guardrail, kind,
agent}`, names only, as D258's hand-off is posted.
**Why:** directives are delivered on the event's session id; moving model
calls to children needs an ingestion fallback first.
**Rejected alternative:** a tracing processor (silent with tracing off,
swallows exceptions); `llm_error` or `policy_block` for a guardrail (not a
model failure or a Flightdeck policy); per-child attribution now.

## D261 -- Flightdeck ships as one binary: the three services in-process, NATS and the dashboard embedded, one topology everywhere

**Date:** 2026-11-07
**Decision:** `flightdeck` (root module, `cmd/flightdeck`) runs ingestion,
the workers and the query API in one process behind one listener
(default `127.0.0.1:4000`): `/` is the embedded dashboard, `/ingest/*`
and `/api/*` reach the two muxes, bare `/v1/*` is not served. NATS runs
embedded (JetStream, no port, store under the data dir) unless
`--nats-url` names a server; migrations are embedded and run at start.
Each service exports an `app` package (`Run`, `Handler`) the binary
composes. On loopback the dev token works; elsewhere or with `--domain`
(TLS via ACME) an `ftd_` token is minted once into `<data>/secrets.json`.
**Why:** the try-it path was the contributor path (clone, compile seven
containers, 5-15 minutes); one process, nothing to configure, one topology.
**Rejected alternative:** an all-in-one container under supervisord (a
second topology, Docker-only); better per-service images (no laptop or
Windows path); nginx as the edge (three routes and autocert replace it).

## D262 -- SQLite is the default storage, Postgres the second backend, behind one `storage` boundary

**Date:** 2026-11-07
**Decision:** the Go services open their database through the `storage`
module: `sqlite://<path>` (default; pure-Go `modernc.org/sqlite`) or
`postgres://…` (pgx as a `database/sql` driver), a `Dialect` for the SQL
that differs and a per-dialect query set where a store differs beyond
it, a `Bus` in place of direct LISTEN/NOTIFY, and embedded migrations in
pairs (SQLite starts from a baseline equal to Postgres 000036).
**Why:** one binary with nothing to install needs an embedded store; the
Helm / multi-instance path still needs Postgres; one boundary keeps the
two from drifting.
**Rejected alternative:** SQLite only (loses the Helm scale path);
embedded Postgres (a 40 MB download and a child process to manage); a
query builder or ORM (hides the SQL the stores are tuned on).

## D263 -- One release pipeline ships the binary through goreleaser; the per-service images retire

**Date:** 2026-11-08
**Decision:** a version tag builds the `flightdeck` binary for `linux`,
`darwin` and `windows` on `amd64` and `arm64` with goreleaser and
publishes it as GitHub release archives with `checksums.txt`, a formula
in `flightdeckhq/homebrew-tap` (stable tags only), platform wheels on
PyPI as `flightdeck-cli` (`flightdeck` is an unrelated project), and one
multi-arch Docker image `flightdeckhq/flightdeck`. `install.sh` and
`install.ps1` download from the release and verify the checksum. The
four per-service images (`flightdeck-ingestion`, `-workers`, `-api`,
`-dashboard`) are no longer published; a from-scratch install gate runs
every channel on fresh runners after each release.
**Why:** one artifact per platform is what the one-binary topology
promises; maintaining both image sets would keep the old topology alive.
**Rejected alternative:** a Homebrew cask (no `brew services` stanza,
which the formula's background mode needs); a PEP 541 transfer of the
`flightdeck` PyPI name (months, uncertain); maturin or a native build for
the wheels (the binary is prebuilt, the wheel only carries it); keeping
the per-service images for one deprecation release (no external users).

## D264 -- The sensor defaults to the local control plane and its dev token, on loopback only

**Date:** 2026-11-08
**Decision:** `flightdeck_sensor.init()` takes no required arguments.
`server` resolves kwarg, then `FLIGHTDECK_SERVER`, then
`http://localhost:4000/ingest`; `token` resolves kwarg, then
`FLIGHTDECK_TOKEN`, then `tok_dev`, and the token default applies only
when the server was defaulted too and its host is loopback. init logs one
WARNING when the dev token is in use. A server given by kwarg or
environment without a token raises `ConfigurationError` (a `ValueError`)
naming both variables; the sensor never sends `tok_dev` to a server the
caller chose.
**Why:** the quickstart is `pip install flightdeck-sensor`, `init()`,
`patch()` against the `flightdeck` binary, which accepts `tok_dev` only
when bound to loopback; the sensor's gate mirrors the server's, so the
pair works on one machine and nowhere else.
**Rejected alternative:** default the token whenever the server is
loopback (a remote reverse tunnel on `localhost` would receive `tok_dev`
silently; the caller chose that server and must choose the token); keep
both arguments required (the quickstart stays at two values the user has
to look up for a stack that already prints them).
