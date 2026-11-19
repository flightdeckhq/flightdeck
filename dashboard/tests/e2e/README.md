# Dashboard E2E tests (Playwright)

End-to-end browser tests for the Flightdeck dashboard. Runs on every
PR and tags the release with a green/red gate per CLAUDE.md rule
40c. Located at `dashboard/tests/e2e/`; shares a seeded Python
fixture dataset with the pytest integration suite via
`tests/shared/fixtures.py` + `tests/e2e-fixtures/seed.py`.

## What's covered

The catalog lives one file per journey. Test numbers are stable
identifiers; gaps (T02, T05, T07–T09, T11, T13, T31, T37) represent
specs that were removed when the affordances they covered were
removed (the `?view=table` toggle, the swimlane expand-row drawer,
the swimlane↔table parity assertion). The current journeys:

| File | Journey |
|------|---------|
| `T01-fleet-page-renders-full-state.spec.ts` | Fleet mounts, fixture agents visible, canonical-pair invariant guard |
| `T03-investigate-facet-filtering-intersection.spec.ts` | Two facets compose via AND; × on a pill relaxes to the single filter |
| `T04-investigate-session-drawer-deep-dive.spec.ts` | Drawer opens from row click; tabs work; close via X |
| `T06-truncation-and-tooltip.spec.ts` | Narrow viewport: long fixture name gets `title` attribute via `<TruncatedText/>` |
| `T10-wholedashboard-smoke.spec.ts` | Every top-level page mounts with no console errors |
| `T12-agent-chip-resolves-name-from-agent-endpoint.spec.ts` | Agent chip renders human-readable name from `/v1/agents/{id}` |
| `T14-embeddings-event-renders.spec.ts` | Embeddings event renders + drawer content tab works; on capture-on runs of its own, a token-id input reads as one input labelled as token ids with its count (`3 tokens`), and two token-id lists as `2 inputs`, each with its own count, the one longer than the preview cut with `, …` until **Show full inputs** |
| `T15-streaming-indicators.spec.ts` | In-flight streaming run shows streaming pill |
| `T16-error-event-renders-and-filters.spec.ts` | llm_error events render; error_type facet filters |
| `T17-policy-events-render-and-filter.spec.ts` | Policy events render; matched_entry_id facet filters |
| `T18-investigate-last-seen-sortable.spec.ts` | Last-seen header is sortable ASC / DESC |
| `T19-investigate-state-sortable.spec.ts` | State header sorts by lifecycle severity ordinal |
| `T20-truncation-tooltips-on-narrow-viewport.spec.ts` | Truncation tooltips on multiple cells at narrow viewport |
| `T21-fleet-no-coding-sensor-anomaly.spec.ts` | Canonical pair invariant: no coding + sensor anomaly row |
| `T22-client-type-label-parity.spec.ts` | ClientTypePill text matches API client_type |
| `T23-investigate-sidebar-resizable.spec.ts` | Investigate sidebar drag-resize persists across reload |
| `T24-fleet-swimlane-horizontal-scroll.spec.ts` | Swimlane scrolls horizontally; sticky agent-name column |
| `T25-mcp-observability.spec.ts` | MCP server names + events render across surfaces |
| `T26-theme-matrix-canary.spec.ts` | Theme storage seeds neon-dark + clean-light identically |
| `T27-fleet-sidebar-policy-events.spec.ts` | Sidebar policy events section + count |
| `T28-claude-code-subagent-fleet-rendering.spec.ts` | Claude Code subagent renders as child topology |
| `T29-crewai-multi-agent-rendering.spec.ts` | CrewAI multi-agent runs render with role attribution |
| `T30-langgraph-multi-node-rendering.spec.ts` | LangGraph multi-node runs render with node attribution |
| `T32-sub-agent-drawer-tab.spec.ts` | Sub-agent drawer tab shows parent / child relationship |
| `T33-sub-agent-investigate-facets.spec.ts` | `is_sub_agent` facet filters Investigate scope |
| `T34-sub-agent-time-flow-connectors.spec.ts` | Bezier connectors from parent spawn → child first event |
| `T35-sub-agent-depth-2-rendering.spec.ts` | Two-level sub-agent hierarchy renders correctly |
| `T36-relationship-pill-navigation.spec.ts` | Click relationship pill jumps to target agent's row |
| `T38-cross-agent-message-rendering.spec.ts` | Cross-agent messages render on parent + child rows |
| `T39-sub-agent-analytics-dimensions.spec.ts` | `agent_role`, `parent_session_id` analytics dimensions |
| `T40-sub-agent-failure-row-cue.spec.ts` | Lost sub-agent surfaces red `i` cue on row + drawer |
| `T41-mcp-policy-operator-workflow.spec.ts` | MCP policy create / edit / dry-run / enforce workflow |
| `T42-investigate-payload-facets-server-side.spec.ts` | Payload facets compose server-side |
| `T43-swimlane-bucket-divider-cluster-integrity.spec.ts` | Bucket divider gridlines stay aligned across clusters |
| `T44-route-rename-301-redirect.spec.ts` | `/investigate` → `/events` 301 with query string preserved |
| `T45-swimlane-one-row-per-agent.spec.ts` | SwimLane renders one row per agent (no session sub-rows) |
| `T46-swimlane-subagent-indent.spec.ts` | Sub-agent rows render with `data-topology="child"` indent |
| `T47-run-bracket-hover-tooltip.spec.ts` | Hovering a run bracket shows tooltip with run metadata |
| `T48-run-bracket-click-opens-run-drawer.spec.ts` | Clicking a run bracket opens the drawer scoped to that run |
| `T49-agent-label-strip-ordering.spec.ts` | Label strip left-to-right order matches the locked spec |
| `T50-active-status-pulse.spec.ts` | AgentStatusBadge pulses only when state is `active` |
| `T51-view-table-toggle-removed.spec.ts` | `?view=table` URL no longer renders an alternate view |
| `T52-concurrent-runs-offset.spec.ts` | Two concurrent runs on the same agent anchor to opposite edges |
| `T53-run-bracket-end-square-live.spec.ts` | RunBracket end-square glyph (■) mounts for a closed-in-window session — regression guard for the end-glyph render path |
| `T54-child-row-bg-tint.spec.ts` | Child swimlane rows carry a visually distinct `background-color` from root rows — regression guard against an inline-style override beating the `[data-topology="child"]` CSS rule |
| `T55-swimlane-sub-agent-session-circle-renders.spec.ts` | Sub-agent swimlane row renders event circles and the connector overlay anchors at least one Bezier path for an in-window parent-child pair — regression guard for the agent-row `last_seen_at` bump that keeps sub-agent rows materialised at default viewport |
| `T123-prompts-rendered-json-per-box.spec.ts` | Every box in the Prompts tab (system prompt, each message, a tool declaration, the response) has its own toggle whose buttons read `Rendered` and `JSON`, on Rendered by default; Rendered shows the content blocks and pretty-prints a message whose text is JSON, JSON on one box shows its stored value as indented JSON that wraps at the box's width and leaves the other boxes on Rendered |
| `T131-event-circles-sit-on-their-row-centre.spec.ts` | Event circles sit on their row's centre line; the expanded ALL row's circles stay inside the row and share the agent rows' x |
| `T132-sub-agent-row-name-keeps-its-role.spec.ts` | A `{parent}/{role}` sub-agent row keeps its `/role` whole at the 460 px default and when the column is dragged narrower; the head gives way |
| `T133-sub-agent-connector-ends-on-the-circles-it-joins.spec.ts` | Every connector starts on its parent circle's rim and ends on its child circle's centre |
| `T134-hovering-a-run-lights-its-connectors.spec.ts` | Hovering a run's mark (or keyboard-focusing its glyph) lights exactly that run's connectors: a parent its fan-out, a child its own link |
| `T135-child-row-label-hides-scrolled-circles.spec.ts` | With circles scrolled under a child row's sticky label, in Fleet and in the per-agent modal (where the child is a group of run lanes, its run's lane label), the label's background is fully opaque |
| `T136-freed-top-lane-is-reused.spec.ts` | A run that starts after an earlier run ended takes the top lane that run freed; the run still overlapping takes the second lane |
| `T137-runs-started-together-keep-reachable-glyphs.spec.ts` | Three runs started together keep disjoint start glyphs; each hit-tests to itself and opens its own run's tooltip |
| `T138-back-to-back-runs-keep-both-glyphs.spec.ts` | At 5m a hand-off (with 3 ms of worker-clock overlap) stays one lane and reads ■▶, both glyphs reachable |
| `T139-closed-run-shows-its-end-with-the-start-off-screen.spec.ts` | At 5m, 15m and 1h a closed run whose start is before the window shows its end square, with a time in its tooltip |
| `T140-lost-run-ends-with-a-hollow-square.spec.ts` | Lost and reaped runs end at their last signal with a hollow square; an earlier lost run draws nothing |
| `T141-resumed-run-draws-its-segments.spec.ts` | A resumed run draws ▶ ■ ▶ with a gap, and a run inside the gap keeps the row one lane |
| `T142-short-run-keeps-its-start-before-its-end.spec.ts` | A run narrower than its glyphs reads ▶■, and no glyph covers its start circle's centre |
| `T143-reaped-run-older-than-the-sessions-page-ends-at-its-last-signal.spec.ts` | A reaped run older than the 24 h sessions page, with its events kept from the page, ends at its last signal with a hollow square, from the rollup's `close_reasons` |
| `T144-fleet-range-switch-keeps-cached-circles.spec.ts` | Widening the Fleet range and switching back keeps a run's newest circle even when the new window's pages lack it; the wider window loads newest first with the keyset cursor (its `limit` rewritten to 50 to force paging) |
| `T145-per-agent-modal-run-glyph-opens-the-run-drawer.spec.ts` | A start triangle in the per-agent swimlane modal opens the run drawer on its run inside the modal; Esc closes the drawer, then the modal |
| `T153-overlapping-runs-split-the-row-into-lanes.spec.ts` | The fan-out worker's three overlapping runs split its one 48 px row into three lanes: each run's circles, start glyph and solid line share its lane's centre, and its earlier lost run takes no lane |
| `T154-row-without-overlap-keeps-one-line.spec.ts` | A single-run row and a hand-off row stay one line: no run lines, 22 px circles on the row's centre line |
| `T155-runs-past-four-share-the-overflow-lane.spec.ts` | Five runs started together draw four lanes with `data-lane-overflow`; the last two share the fourth, every start glyph hit-tests to itself and the shared ones say `shared by 2 runs` |
| `T156-sub-agent-connector-ends-on-the-child-run-lane.spec.ts` | Each coordinator-to-worker connector ends on its run's circle, one end per lane at distinct heights |
| `T157-quiet-run-line-turns-dashed.spec.ts` | A stale run's line is solid to its last signal and dashed after it (`data-tail="quiet"`); the active run's line stays solid |
| `T158-run-line-opens-its-run-when-no-glyph-is-in-view.spec.ts` | With neither run's glyphs in view, each run line takes keyboard focus and Enter opens its run drawer; with the glyphs in view the lines leave the tab order |
| `T161-newest-circles-and-glyphs-stay-inside-the-panel.spec.ts` | At 1h the newest circle sits whole inside its panel with its centre where the grid lines put its time, and a just-started run's ▶ sits at its own start inside the panel |
| `T150-agent-tokens-count-failed-streams.spec.ts` | The Agents row's token total counts a failed stream's billed tokens and an embeddings call after a load, and adds a failed stream posted while the page is open without a reload |
| `T167-fleet-row-below-the-fold-scrolls-into-view.spec.ts` | A swimlane row several screens below the fold, unmounted by the virtualization, is walked to and ends in the viewport; asked again once mounted, the helper scrolls straight to it without snapping the scroller to the top |
| `T168-per-agent-modal-draws-one-lane-per-run.spec.ts` | At 1920x1080 the fan-out worker's modal draws a heading and three lanes, one per open run in start order (none for its lost run), each labelled with the run's short id, state, model and tokens; the equal lanes fill the scroll viewport to within a few pixels of the Live feed, with nothing to scroll; the heading shows the whole agent name; marker text is T172's, on runs of its own |
| `T169-per-agent-modal-single-run-keeps-its-maximum.spec.ts` | With "Show sub-agents" on, the coordinator's worker and wide sub-agents are child groups of 3 and 5 run lanes, without a runs chip; with it off, the coordinator's one run gets one 144 px lane (the maximum), not the whole modal |
| `T170-per-agent-modal-many-runs-scroll.spec.ts` | At 1280x720 the wide sub-agent's five runs draw five 40 px lanes (the minimum, no overflow lane); the Live feed gives up height until the first three show whole, and the viewport scrolls to the last one |
| `T171-fleet-runs-chip-opens-the-per-agent-modal.spec.ts` | At 1700 px and 1280x720 the worker's and the wide row's runs chips read `3 runs` / `5 runs` with matching tooltip and accessible name, sit in the badge column under the status badge of a 48 px row; the one-run coordinator has none; Enter on the focused chip, and a click, open the agent's per-agent modal; an agent of its own with ten runs reads `9+ runs` (full count in its tooltip) and fits the 88 px badge column |
| `T172-per-agent-modal-small-window-shows-three-lanes.spec.ts` | On an agent of its own with three runs at 1280x720, the Live feed gives up height (not below 114 px) so the three lanes show whole with nothing to scroll; the heading's name is whole; at 5m (where both calls keep their places for over 100 s, whatever the spec's pace) a 60 s old call names itself on its run's lane inside the view and a 200 s old call under the label column shows no name; scrolled back to the window's start, the 200 s call names itself inside the view |
| `T173-per-agent-modal-lane-hover-lights-feed-rows.spec.ts` | On an agent of its own with two runs, pointing at a lane's label lights that lane and all of its run's Live feed rows and none of the other run's; the other lane's panel moves the light; pointing away puts it out |
| `T174-per-agent-modal-feed-row-hover-lights-lane-and-circle.spec.ts` | On an agent of its own, pointing at a Live feed row lights its run's lane and rings that event's circle alone; the next row of the same run moves the ring; another run's row moves the light to its lane |
| `T175-per-agent-modal-lane-label-filters-feed.spec.ts` | A lane's label (`aria-pressed`, named `Run <id8>`) filters the Live feed to its run and shows the `Run <id8>` chip; another label switches, the same label clears; the chip takes the keyboard focus and Enter clears, the focus going to the run's label; narrowed to 1m the filter on a run with nothing in the window stays and the feed reads `No events from run <id8> in this window`, and 5m brings its rows back with the label pressed; Esc clears the filter (focus to the label) and leaves the modal open, a second Esc closes it |
| `T176-per-agent-modal-sub-agents-get-lane-groups.spec.ts` | A coordinator of its own spawning a reviewer (one run) and a tester (two runs): with "Show sub-agents" on the coordinator's group comes first, then a child group per sub-agent with its runs' lanes; each connector ends on its child run's circle on that run's lane; at 1280x720 the coordinator's lanes show whole; off, its group alone |
| `T177-per-agent-modal-cues-count-lanes-out-of-view.spec.ts` | At 1920x1080 and 1280x720, a coordinator of its own with eight runs and two sub-agents (twelve lanes, three headings): at the top, middle and bottom of the scroll the cues read the lanes out of view (`<n> more below` / `<n> more above`, each absent at its end), the top one in the axis row's label cell and the bottom one on the strip under the viewport, and neither's box meets a visible circle, marker text, lane label text or heading pill; a click on the bottom cue brings the next lane fully into view, one on the top cue scrolls back up; no live region |
| `T180-prompts-tab-shows-openai-tool-calls.spec.ts` | On an agent of its own, an OpenAI chat `post_call` whose stored messages are a tool-use loop (user, assistant with `tool_calls` and `content: null`, `tool` reply): in the event drawer's Prompts tab the assistant's box shows the call (the tool's name, then `city:` and its value) instead of `(empty)`, the reply is labelled `tool result` with the name of the tool it answers, and the JSON view keeps the message as stored, `arguments` still a JSON string |
| `T181-prompts-tab-names-the-call-a-responses-output-answers.spec.ts` | On an agent of its own, an OpenAI Responses `post_call` whose stored `input` is a tool-use loop (user message, `function_call`, `function_call_output`): the `function_call` item shows the function's name, its `call_id` and `city:` with its value, the output item is labelled `tool result` with the name of the function it answers, keeps its `call_id` line and shows its output, and the JSON view keeps the item as stored |
| `T182-prompts-tab-shows-a-gemini-function-calling-round-trip.spec.ts` | On an agent of its own, the two google-genai `post_call`s of an automatic-function-calling round trip, their content the request and response bodies as the sensor stores them: round one's tool box is named by its function (not `tool_0`) and its response shows the model's `functionCall` (the function's name, then `city:` and its value); round two's turns carry their `user` / `model` roles, the model's turn shows the call with its `thoughtSignature` as a mark (the value not shown), the user's `functionResponse` is labelled `function response` with the function it answers and its result, and the JSON view keeps the turn as stored |
| `T183-prompts-tab-shows-a-gemini-thinking-response.spec.ts` | On an agent of its own, a google-genai `post_call` whose response holds a `thought` part and an answer part carrying a `thoughtSignature`: the system instruction shows under its own name, the thought is labelled `thought` apart from the answer, the signature is one mark, `thoughtSignature · opaque bytes, in JSON`, with its value not in the Rendered view, no finish reason shows for `STOP`, the token line reads `Tokens in: 17 · Tokens out: 123` (the thoughts counted as output), and the JSON view holds the signature as stored |
| `T184-prompts-tab-shows-a-responses-tool-loop.spec.ts` | On an agent of its own, the two OpenAI Responses `post_call`s of a tool loop: the first call's response shows the `function_call` output item (the function's name, its `call_id`, its arguments as fields), not the response object, with the token line, and the JSON view keeps the object; the second call's input shows the same item with the same markup, and its response shows the answer's text |
| `T185-prompts-tab-shows-a-responses-reasoning-response.spec.ts` | On an agent of its own, an OpenAI Responses `post_call` whose output is a `reasoning` item with a summary and `encrypted_content`, then the answer: the reasoning is labelled `reasoning` with its summary, the mark `encrypted_content · encrypted reasoning, in JSON` shows and the encrypted content does not (the JSON view keeps it), then the answer and the token line, with no status line for a completed response |
| `T186-prompts-tab-shows-a-chat-refusal.spec.ts` | On an agent of its own, two OpenAI chat `post_call`s: a response whose message refused (`content` null, `refusal` set) shows the refusal labelled `refusal`, not the response object, and the next call's passed-back message shows it the same way, not `(empty)` |
| `T187-prompts-tab-shows-a-responses-refusal.spec.ts` | On an agent of its own, two OpenAI Responses `post_call`s: a response whose message holds a `refusal` part shows it labelled `refusal`, not the response object, with the same markup the next call's input shows the passed-back part with |
| `T188-embeddings-event-opens-its-input-in-the-prompts-tab.spec.ts` | On an agent of its own, two runs with one `embeddings` call each and no other content (an OpenAI call with two texts, a google-genai `embed_content` call with the Gemini API's `Content` objects): the event drawer's Prompts tab, the run drawer's "View Prompts →" on the expanded row, and the run drawer's full detail of the row each show the input under the provider's name for it (`Input`, `Contents`), drawn as the expanded row draws it, its JSON view the stored input, and the event's `output_dimensions` under Output, never `{}` nor a vector |
| `T190-agent-drawer-swimlane-button-names-runs-at-once.spec.ts` | On agents of its own: one with three runs at once, whose drawer's swimlane button reads `Open in swimlane · 3 runs`, named `Open <agent> in swimlane, 3 runs at once` with the tooltip `3 runs at once: each gets its own lane`, and opens the per-agent modal with three lanes; one with a single run, whose button is the plain `Open in swimlane` with no count or tooltip |
| `T192-preflight-removes-only-private-runs.spec.ts` | The seed's gate agent the pre-flight looks for is the id the seed stored; given a private agent's run, a look-alike (named as `createPrivateAgent` names agents, on the private host plus a suffix) and a seeded fixture's run, the E2E pre-flight limited to those three removes the private run and its agent only; with a seed agent id no database holds, or with an agent-name prefix the rest of the fleet does not carry, it removes nothing; a prefix that does not extend `e2e-` (`""`, `"o"`) or an id that is not a uuid throws before psql starts; in a transaction it rolls back, the SQL itself refuses such a prefix and refuses to delete a listed run on the private host whose row names a real agent (`dev@dev-laptop`); on a stack that is not an E2E stack it removes nothing |
| `T193-embeddings-only-run-lists-its-calls-in-the-prompts-tab.spec.ts` | On an agent of its own, one run whose only content is three OpenAI `embeddings` calls, each with its own two texts: the run drawer's Prompts tab lists the three, newest first, each row with the `EMBED` badge and the model, never "No content was recorded for this run."; each row opens the embeddings view on its own texts with its `output_dimensions` under Output (no Response section), and "← Back to event list" returns to the three rows; the Timeline's "View Prompts →" on the oldest call opens it, and Back lands on the list with its row focused |

The `_fixtures.ts` helper exports shared fixture metadata (agent
names, flavors, role timeline offsets) and locator helpers:
`findSwimlaneRow`, `bringSwimlaneRowIntoView`, `readSwimlaneRows`,
`waitForFleetReady`, `waitForInvestigateReady`, `investigateParamsFromUrl`, and
`agentIdByName` / `openPerAgentModal` (the modal through the agent
drawer's "Open in swimlane"), and the private-agent helpers
`createPrivateAgent` / `startPrivateAgent` / `postPrivateToolCall` /
`postPrivatePostCall` / `postPrivateEmbeddings` / `endPrivateAgent`: an agent of one spec run's
own, named `e2e-test-<label>-<id>`, with runs started through ingestion
(their `session_start` can be dated in the past), so its lanes draw
only what the spec posts (T171's ten-run row, T172's marker text,
T173-T177), and a run's content is only what the spec captured (T180's
OpenAI chat, T181's Responses, T182's and T183's Gemini and T184-T187's
Responses and refusal `post_call`s, posted with `postPrivatePostCall`,
and T188's and T193's `embeddings` calls, posted with `postPrivateEmbeddings`,
which returns the id of the call it stored, so a run can take several).
`createPrivateSubAgent` makes a sub-agent of one, `<parent>/<role>`,
each of its runs started under a run of the parent (T176). The spec keeps
the agent from `createPrivateAgent` before `startPrivateAgent` waits, so
its `afterEach` ends the runs even when the start fails. On the seed's shared runs the
seed's, the keep-alive's and other specs' calls decide which marker
texts have room, so a spec asserts marker text only on runs of its own.

## Running locally

Prerequisites: a running dev stack on Postgres and Playwright's
Chromium browser installed. The stack is the `flightdeck` binary with
the dashboard's production bundle embedded, so the suite tests the
bundle users get; `make dev` rebuilds the bundle when a dashboard
source is newer than it. The suite does not run against the stack on
SQLite (`make dev DB=sqlite`): the seeder backdates rows with Postgres
SQL, and three files run `psql` in the stack's Postgres container.

The specs take the stack from `_stack.ts`. On `http://localhost:4000`
the Postgres container and the database come from `.dev/stack.env`,
which `make dev` writes. A stack at another address names itself with
`FLIGHTDECK_TEST_BASE_URL`, `FLIGHTDECK_TEST_POSTGRES_CONTAINER` and
`FLIGHTDECK_TEST_DB`: `make test-e2e` sets them from the dev stack's
state, so a second dev stack's run stays on that stack; before `npm
run test:e2e` or `npx playwright test` against a second stack, run
`eval "$(scripts/dev-stack.sh env)"` from the repo root with that
stack's `FLIGHTDECK_DEV_*` variables set. `globalSetup` stops the run,
saying why, on a stack on SQLite and on another address that does not
name both its container and its database: nothing falls back to
`docker-postgres-1`. A spec never writes a literal `localhost:4000` or
container name.

```bash
# Boot the stack (idempotent — re-running is safe)
make dev
# After editing dashboard or Go sources: rebuild and restart it
make dev-restart

# Install Playwright browsers once per machine
cd dashboard
npx playwright install chromium --with-deps

# Run the full suite (neon-dark + clean-light, ~30s on fresh DB)
npm run test:e2e
# or
make test-e2e
```

For iteration:

```bash
npm run test:e2e:headed           # watch it run in a real Chromium
npm run test:e2e:ui               # Playwright's interactive UI mode
npx playwright test T05           # single test by filename substring
npx playwright show-trace <path>  # inspect a failed run's trace.zip
```

### Seeding the fixture dataset manually

`globalSetup.ts` seeds the canonical dataset before every
`playwright test` invocation, but you can re-seed by hand while
iterating on a fixture shape:

```bash
make seed-e2e
# or
python3 tests/e2e-fixtures/seed.py
```

The seeder is idempotent: sessions with ≥3 events are skipped on
subsequent runs. Fresh-active sessions get a fresh `tool_call`
event every run so they stay visible in the default 1-minute
swimlane window regardless of how long ago the previous seed ran.

### The pre-flight: runs earlier runs left

Before it seeds, `globalSetup` removes the runs earlier runs' specs
made for themselves (`clearPrivateFixtures`, `_private-fixtures.ts`),
so a local run starts from the seeded fleet as a CI run on its fresh
database does, whatever an interrupted run left. It logs one line:
how many runs and agents it removed.

What it removes: the private runs, told apart by the host they send,
one exact host per producer (`createPrivateAgent` and its
`postPrivate*` calls, `createPrivateSubAgent`, `_tool-content-run.ts`'s
`newRun`, T130, T149, T150, T164; the list is `PRIVATE_FIXTURE_HOSTS`),
with an agent named `e2e-...`: the sessions, their events, content,
directives and start receipts, and each agent they leave with no run.
A helper or spec that makes runs of its own takes its host from that
list.

What it never removes: anything on another host, even one that only
extends a private host (the match is exact); the seed's fixtures, whose
hosts are not in the list; and nothing at all on a stack that is not an
E2E stack. It tells an E2E stack by its data, since the address does
not tell (CI's stack and a developer's own dev stack both answer on
`http://localhost:4000`), on two conditions, both checked in the
transaction that deletes:

- every agent in the database is named `e2e-...`, as the seed's and the
  specs' are: one real Claude Code session, playground run or
  integration-suite agent rules it out;
- the database holds the seed's coding fixture agent
  (`e2e-test-coding-agent`), by the id the seed derives for it from
  `canonical.json`: a database the E2E seed never wrote is not one.

Where either fails it deletes nothing and its line says which
(`pre-flight deleted nothing: ... so this is not an E2E stack`). It runs
before the seed, so the seed it requires is an earlier run's; on a
database never seeded (CI's, before `globalSetup` seeds it) there is no
run to remove and its line says so. A row on a private host that names
any other agent fails the run, with nothing deleted. A spec may limit
the pre-flight to runs of its own and make either condition stricter
(T192), never looser: a prefix it passes must extend `e2e-` (checked
before psql starts and again in the SQL), only adds agents to the
not-an-E2E-stack count, and never replaces `e2e-` in the check of the
runs to delete; a seed agent id it passes is required as well as the
seed's, under the seed agent's name. One transaction,
through `psql` in the stack's Postgres container as `removeRun` does
(the API deletes no run or agent): it removes every leftover or none,
and a failure stops the run. One run per stack at a time: the
pre-flight, like the seed, assumes no other run's specs are live on the
stack.

### Accumulated dev-DB data and virtualization

The Fleet swimlane uses `VirtualizedSwimLane`; off-screen rows
render as same-height spacers, not real DOM. In practice this
means: if a dev machine's Postgres holds agents from months of
prior test runs, the fixture agents can land 30+ positions down
the sorted list and never enter the viewport. Tests key on
`data-testid` attributes, not text, so the testids simply aren't
in the DOM.

Remedies:

- Run the suite on a stack of its own (a second dev stack, its own
  port and Postgres): there the pre-flight above removes the private
  runs of earlier runs at the start of every run.
- `make dev-reset` deletes the dev database — the clean slate is
  what CI always sees, so this is the fastest way to make local
  behaviour match CI. It deletes every session in it, yours included.
- Stop any background agent that's pushing events to the dev
  stack (e.g. `FLIGHTDECK_SERVER=http://localhost:4000` set in
  your shell while a Claude Code plugin session is active).

## Architecture

### Fixtures

`tests/e2e-fixtures/canonical.json` is the declarative source of
truth — agent names, flavors, role timeline offsets. Three
agents, two with the full four session roles (fresh-active,
recent-closed, aged-closed, stale) and one with the two roles
needed by the truncation test. Session IDs derive deterministically
from `uuid5(NAMESPACE, "flightdeck-e2e/<agent_name>/<role>")` so
the same IDs land on every seed run.

`tests/e2e-fixtures/seed.py` reads `canonical.json`, POSTs events
to the ingestion API (using `tests/shared/fixtures.py::make_event`
— the same builder the pytest integration suite uses), then
back-dates aged-closed/stale sessions via `docker exec psql` so
their visible timestamps match the declared offsets. Fresh-active
sessions get an extra `tool_call` event every seed run to keep
their in-window recency invariant.

`dashboard/tests/e2e/_fixtures.ts` mirrors the canonical metadata
in TypeScript so spec files reference agents and roles via
type-safe constants instead of stringly-typed magic.

The fan-out fixture (`FANOUT_FIXTURE`) is a coordinator,
`e2e-test-fanout@e2e-host-fanout`, and its same-role sub-agent
`e2e-test-fanout@e2e-host-fanout/worker`: an earlier lost run (started
-2 h, last seen -1 h 55 min) and three runs started together. Roles
with `fanout_group` are pinned by `seed.py::_refresh_fanout` in one
psql statement, so they share one NOW(), on the full seed and on every
keep-alive cycle, which also posts the coordinator's spawn event 1 s
before the workers' events. Every fan-out role declares
`skip_subagent_refresh`, so T56's `--refresh-subagent-events` never
moves it, and the lost run is pinned once by the full seed.

The run-glyph lane fixtures (`LANE_FIXTURES`, the `e2e-test-run-*`
agents) are roles that declare `lane_segments`: the run's segments as
`[start, end]` offsets from NOW (`end` null while open) and its
`lane_state`, optionally a last-signal offset and a close reason (the
reaped run's `orphan_timeout`). `seed.py::_pin_lane_fixtures` pins
each run's session row back to those offsets in one psql call for all
of them, on the full seed and on every keep-alive cycle, so a spec sees
them at most one keep-alive cycle plus its own runtime late. A role
that sets `lane_shift_events` (the resumed run and the short run,
whose specs read their `session_end` boundaries) has its whole event
stream shifted with the row; every other lane run reads its boundaries
from the row, since the swimlane ignores events dated before
`started_at`. The pin drops every `session_end` a role does not
declare (the reaper's work on a stack left running without the
keep-alive, or a client closing a fixture run mid-suite), and pins the agents' `last_seen_at` 60 s back
(`LANE_AGENT_SEEN_AGO_SEC`), so their rows sit just below the Fleet's
LIVE rows: near enough for the lane specs to scroll to quickly, without
crowding the LIVE rows other specs read out of view. None is a sub-agent, so T56's refresh leaves them alone.
`fixtureSessionId(agent, role)` derives a fixture run's session id the
way `seed.py::_derive_session_id` does.

The long-run fixture (`LONG_RUN_FIXTURE`, T146) is one run of
`e2e-test-long-run` with 2,050 tool calls and a needle as its newest
event. `globalSetup` seeds it through ingestion
(`tests/e2e-fixtures/seed_long_run.py`) when the stack has none and
waits until the worker has stored it, before any spec starts. A spec
must not post a burst like it: the worker announces every event it
stores on the live stream, one frame each, and a Fleet page with the
stream on (T149's) stops answering Playwright for seconds while it
takes two thousand of them. Seed anything of that size in
`globalSetup`.

### Selectors

Prefer semantic selectors first (`getByRole`, `getByText`,
`getByLabel`). `data-testid` only where semantic selectors are
brittle or the text itself is dynamic. When introducing a new
testid, follow the existing `<domain>-<component>-<role>`
convention: `fleet-*`, `swimlane-*`, `session-*`, `context-*`,
`investigate-*`.

Structural testids the suite relies on:

- `swimlane-agent-row-<agent_name>` + `data-agent-id` + `data-topology` (SwimLane row root)
- `swimlane-run-bracket-start-<sid_prefix>` + `swimlane-run-bracket-end-<sid_prefix>` (RunBracket; a resumed run has one per segment), with `data-session-id`, `data-run-lane` (`0` is the top lane), `data-segment-index` and, on an end, `data-end-kind` (`closed` or `lost`); the row carries `data-lane-count` (1 to 4) and, with more runs overlapping than lanes, `data-lane-overflow="true"`
- `swimlane-run-line-<sid_prefix>` (RunLine, one per segment on a split row), with `data-session-id`, `data-run-lane`, `data-segment-index`, `data-tail` (`live` or `quiet`), `data-shared` in the overflow lane and `data-highlighted`; its parts are `swimlane-run-solid-part` and `swimlane-run-quiet-tail`, and its tooltip `swimlane-run-line-tooltip-<sid_prefix>`
- `swimlane-agent-status-badge` + `data-state` (AgentStatusBadge)
- `swimlane-runs-chip` (the Fleet row's runs chip under the status badge), with `data-run-count` (the full count; the label reads `9+ runs` past nine)
- `feed-body-frame` (the Live feed's body, whose height the per-agent modal can cap)
- per-agent modal run lanes: the agent's row (`swimlane-agent-row-<agent_name>`) carries `data-run-lanes="true"` and `data-lane-count` (lanes drawn); `swimlane-run-lanes-heading`; each lane `swimlane-run-lane-<sid_prefix>` with `data-run-lane-row`, `data-run-id` and `data-lane-index`, its label `swimlane-run-lane-label` (`swimlane-run-lane-id`, `swimlane-run-lane-status` + `data-state`, `swimlane-run-lane-model`, `swimlane-run-lane-tokens`); `swimlane-marker-text` (a kept marker text, with `data-marker-for`, its circle's event id, and `data-marker-row`: `beside`, `above` or `below`); `swimlane-run-lanes-empty` with no run in the window
- `swimlane-sub-agent-lost-dot` (lost sub-agent cue inside the row strip)
- `session-circle-<session_id>` (EventNode circles), with `data-event-id`, `data-session-id` and, on an agent row, `data-run-lane`
- `session-drawer` (SessionDrawer root)
- `active-filter-pill` + `active-filter-remove` (Events page facet chip)
- `virtualized-placeholder` (off-screen SwimLane placeholder)

### Find-my-fixture, not assume-first-row

Dev DBs are shared and noisy. Every spec filters by the
`e2e-test-` prefix or targets an exact fixture name before
asserting. Never `.first()` on an unfiltered locator — the first
row in the DB might be unrelated data.

### No setTimeout; prefer auto-wait

Playwright's `click`, `expect`, and `waitFor` have built-in
timeouts. Use those. Explicit `waitFor` is only justified for
non-DOM events (WebSocket connects, URL-param writes). Never use
`setTimeout` — it flakes under load and hides real timing bugs.

### A mark moves under a resting pointer

The swimlane does not hold still. The window advances (3 px a second
at 5m), and every row below the divider between the live and the
recent agents shifts 9 px when that divider comes or goes, which it
does whenever an agent passes 15 s without an event: one that another
spec has just posted for, or a keep-alive fixture. A 10 px glyph then
leaves the pointer and its tooltip closes for good.

- Hover and assert in one retried block: `hoverUntil(hover, shows)`
  from `_hover.ts`, with `HOVER_SHOWS_MS` as the timeout of the
  assertions inside it. A bare `hover()` followed by `expect(tooltip)`
  fails whenever the shift lands between the two.
- Compare positions read in one synchronous `evaluate`. Boxes read one
  `boundingBox()` at a time can be 9 px apart on the same lane.

### A row moves or unmounts between round trips

The Fleet's first render mounts every agent's row, including the rows
far below the fold; a frame later the scroller jumps to its right
edge, and a frame or two after that the IntersectionObserver swaps the
rows out of view for placeholders. Later, rows shift with the divider
above. So a row a spec found in one page round trip can be elsewhere,
or gone, by the next, and every round trip costs: the trace records
the page before and after it, up to a second or more on a busy page.
A spec that looks a row up, then reads it in several more calls, spends
its budget on a slow machine and reads rows that have moved.

- Read a row's own content with `readSwimlaneRows(page, names)` inside
  `expect.poll`: one evaluation per attempt finds each row (walking the
  scroller to a row below the fold) and reads its client-type pill and
  agent-type badge at the moment it is mounted, and the poll repeats the
  whole lookup (T01, T22).
- Scan the rows mounted right now with one `evaluateAll`, never a
  `count()` followed by `nth(i)` calls (T21, T50), and read one row's
  several fields in one `evaluate` (T49).
- `bringSwimlaneRowIntoView` finds the row and scrolls it into view in
  one evaluation, without waiting for it to hold still. Use it before
  pointing at or clicking the row, and assert with web-first
  assertions.

### A test that passed only on its retry

CI retries a failed test once, so such a test leaves the check green.
The E2E job lists each one in its summary and as a warning annotation
(`scripts/e2e_retried_tests.py`), and fails when more than two did in
one run. A listed test is a bug in the spec or in the product: open
its trace in the `playwright-report` artifact and fix the cause.

## Theme agnosticism

Playwright projects `neon-dark` and `clean-light` seed each theme
via localStorage before every test. Every spec runs under both.
Per rule 40c.3, spec files MUST NOT hardcode theme-specific
selectors or colours — assertions reference CSS custom
properties (`var(--text)`, `var(--accent)` …) indirectly via
structural position, never by computed colour value.

## CI integration

The suite runs in `.github/workflows/ci.yml` as four shards
(`e2e-shard`, `npx playwright test --shard=N/4`, both theme projects),
in parallel with the `integration` job. Each shard runs on its own
runner: it installs sensor + dashboard deps, Go and Chromium, boots its
own dev stack with `make dev` (the binary built from the commit, the
dashboard's production bundle embedded, on Postgres), seeds fixtures,
runs its share of the tests, uploads a blob report, and on failure
uploads `test-results/` and prints the binary's log.
The `E2E (Playwright)` job then merges the four blob reports into one
HTML report (the `playwright-report` artifact) and fails unless every
shard passed. A shard takes about 7 minutes.

Branch protection on `main` should require the `E2E (Playwright)`
check before merge; a repository admin sets it.

## Debugging failures

1. **Read the last message** — Playwright prints the failing
   locator, the expected value, and the actual.
2. **Open the trace** — `npx playwright show-trace
   test-results/<slug>/trace.zip`. The viewer walks every step
   with pre/post-screenshots and the network panel.
3. **Run with `--headed`** — watch the browser. Useful for
   flake diagnosis and for understanding what the page actually
   looks like during a specific failure.
4. **Use `--ui`** — interactive runner; pause on failure, step
   through, re-run a single spec without re-seeding.
5. **Screenshots on failure** — saved to
   `test-results/<test>/test-failed-<n>.png`.
6. **Dashboard console logs** — forward via
   `page.on("console", …)` in a debug spec. Browser errors
   (pageerror) fail T10 automatically.

Common classes of flake:

- **Stale dashboard build** — `make dev-restart` after editing
  source: the suite runs against the bundle embedded in the binary,
  not against the sources.
- **Dev-DB pollution** — `make dev-reset` + re-seed.
- **Aged fresh-active** — if a session's state is `stale` when
  the test expects `active`, the seed hasn't been re-run
  recently. `make seed-e2e` pins state+last_seen_at.

## Adding a new test

1. File name: `Tnn-<short-journey>.spec.ts` (zero-padded, kebab-case).
2. Import shared helpers from `./_fixtures`.
3. Use `waitForFleetReady(page)` or `waitForInvestigateReady(page)`
   as your first wait after `page.goto`.
4. Scope every locator with a fixture-prefix filter.
5. Prefer fixture-metadata-derived expected values over hardcoded
   counts.
6. Run locally twice against unchanged code before pushing — rule
   40c.1 forbids flakes.

## Adding a new fixture shape

1. Update `canonical.json` with the new agent / role / timeline.
2. Mirror the constants in `_fixtures.ts`.
3. If the new fixture needs custom seeding logic (e.g. an event
   pattern not covered by the existing four roles), extend
   `tests/e2e-fixtures/seed.py::_post_session_events` and keep
   the idempotency check honest.
4. If the new fixture drives a new test, add the test; don't
   silently expand an existing one.
