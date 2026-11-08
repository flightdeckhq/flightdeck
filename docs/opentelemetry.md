# OpenTelemetry into Flightdeck

Flightdeck's ingestion API receives OpenTelemetry on `/ingest/v1/logs` and
`/ingest/v1/traces` (OTLP over HTTP, protobuf or JSON, gzip or not). Two
producers are mapped: Claude Code's own telemetry, for the runs the Claude
Code plugin does not see, and the GenAI spans the agent frameworks below
export. Both observe only: no Stop, no token budget, no directive reaches
such a session. The sensor and the plugin are the live, enforcing paths;
report a run one way, since a run reported twice counts twice.

## Claude Code over OpenTelemetry

Claude Code exports OpenTelemetry of its own, and Flightdeck's ingestion API receives it. This reaches runs the plugin does not see: `claude --bare` (it runs no hooks, a plugin's included), CI jobs and cloud sessions without the plugin, the TypeScript Agent SDK (the sensor covers the Python one), and any Claude Code whose telemetry is pointed at Flightdeck. Set these in the environment Claude Code starts in:

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=https://flightdeck.example.com/ingest
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ftd_..."
export OTEL_LOGS_EXPORT_INTERVAL=1000
export OTEL_RESOURCE_ATTRIBUTES="host.name=$(hostname)"
```

- `CLAUDE_CODE_ENABLE_TELEMETRY=1` turns Claude Code's export on.
- `OTEL_LOGS_EXPORTER=otlp`: every event Flightdeck stores comes from Claude Code's log events (prompts, model calls with tokens, TTFT and Claude Code's own cost, tool calls, denied tools, API errors, sub-agents). Leave `OTEL_METRICS_EXPORTER` and `OTEL_TRACES_EXPORTER` unset: the receiver accepts metrics and traces and counts them in its response, but stores neither.
- `OTEL_EXPORTER_OTLP_PROTOCOL`: Claude Code has no default. `http/protobuf` and `http/json` both work, gzip-compressed or not; `grpc` does not, since the receiver speaks OTLP over HTTP only.
- `OTEL_EXPORTER_OTLP_ENDPOINT`: the exporter appends `/v1/logs`, which the edge proxy routes to ingestion. On the dev stack: `http://localhost:4000/ingest`.
- `OTEL_EXPORTER_OTLP_HEADERS`: a Flightdeck token, the kind the sensor and the plugin use (`tok_dev` on the dev stack).
- `OTEL_LOGS_EXPORT_INTERVAL=1000`: Claude Code sends logs in batches every 5 seconds and flushes at exit under a short timeout, so a `claude -p` or Agent SDK run that is killed, or slow to flush, can lose its last batch. A 1-second interval narrows that window; an interactive session can keep the default.
- `OTEL_RESOURCE_ATTRIBUTES`: Claude Code sends no host name, so without `host.name` all of a user's machines are one agent, `<user>@unknown`. The same comma-separated list takes Flightdeck's own keys: `flightdeck.flavor` (default `claude-code`), `flightdeck.billing_mode` and `flightdeck.capture_prompts` (below). The billing mode defaults to `subscription`; set `metered` for a run that pays per token, so its cost counts toward estimated cost. A `claude --bare` run always does: it signs in only with `ANTHROPIC_API_KEY`, an `apiKeyHelper` or a cloud provider's credentials, never a claude.ai login.
- Leave `OTEL_SERVICE_NAME` unset. Flightdeck recognises Claude Code by `service.name=claude-code` and counts the records of any other service name as rejected (`source "<name>" is not mapped`); tell agents apart with `flightdeck.flavor`.

**Tool details (opt-in).** `OTEL_LOG_TOOL_DETAILS=1` makes Claude Code name an MCP tool call's server and tool, which Flightdeck puts on the `mcp_tool_call` and on a denied call's signal (without them the call is a `tool_call` named `mcp_tool`), and a custom sub-agent by its name rather than `custom`. It also sends each tool's parameters and input, such as a Bash command line, and a failed tool's error text. Flightdeck stores a tool's input and a failed tool's error text only on a session whose `flightdeck.capture_prompts` is `true`, and a repository can set that flag (below) unless managed settings, or `--settings`, set `OTEL_RESOURCE_ATTRIBUTES`.

**What a repository can change.** Claude Code applies the `env` of a repository's `.claude/settings.json` and `.claude/settings.local.json` over your shell, but ignores there the variables that turn telemetry on or choose where it goes and what content it carries: `CLAUDE_CODE_ENABLE_TELEMETRY`, the exporter selectors, the `OTEL_LOG_*` content switches and the `OTEL_EXPORTER_OTLP_*` endpoint, header and protocol variables (Claude Code 2.1.282 and later). Of those, a repository can only switch an exporter or a content switch off, and only over your user settings. Two variables Flightdeck reads stay open to it: `OTEL_RESOURCE_ATTRIBUTES`, whose value replaces yours, so it can set `flightdeck.capture_prompts=true`, a flavor or a host; and `OTEL_SERVICE_NAME`, which can keep its runs out of Flightdeck. Prompt text, tool inputs and a failed tool's error text still reach Flightdeck only when your own `OTEL_LOG_USER_PROMPTS` and `OTEL_LOG_TOOL_DETAILS` send them, gates a repository cannot open; an API error's message, up to 200 characters, needs only the capture flag. Only managed settings, or JSON passed with `--settings`, outrank a repository's settings. `--setting-sources user` leaves them out, and with them the repository's CLAUDE.md, rules, skills, commands, agents and hooks (checked on Claude Code 2.1.316).

What the dashboard shows for such a session:

- A `claude_code` session (`agent_type=coding`) with an `OTEL` pill beside its Claude Code pill, and "via OpenTelemetry" in its run drawer. Its agent is `<user>@<host>`, the user being the signed-in `user.email` (personal data, stored on the agent), else the account id, else `unknown`.
- It observes only: no Stop, no Stop All and no custom directive reaches it.
- Content stays off unless the exporter asks for it twice: `flightdeck.capture_prompts=true` (not `1`) in `OTEL_RESOURCE_ATTRIBUTES` turns capture on for the session, and Claude Code then sends the prompt text only with `OTEL_LOG_USER_PROMPTS=1`, and tool inputs and a failed tool's error text only with `OTEL_LOG_TOOL_DETAILS=1`. An API error's message, up to 200 characters, needs only the capture flag, which a repository can set (above). With capture off, Flightdeck stores names, ids, counts, durations and whether each call succeeded. No server setting overrides this; the settings Claude Code runs with decide (see What a repository can change, above). `OTEL_LOG_USER_PROMPTS=1` also makes Claude Code send response text, which Flightdeck does not store; `OTEL_LOG_ASSISTANT_RESPONSES=0` keeps it off the wire.
- Running the plugin as well is safe. When the plugin, or the sensor's Agent SDK interceptor, already reports the Claude Code session, its OpenTelemetry records are dropped (counted as rejected in the export response), so nothing is counted twice. The check runs on the session's first export, so a session whose telemetry arrives before the plugin's first event is reported by both.
- Claude Code sends no event when a session ends. The session goes `stale` after 2 minutes without a record and `lost` after 30, and the workers close it 24 hours after its last record by default (`FLIGHTDECK_ORPHAN_TIMEOUT_HOURS`, `close_reason=orphan_timeout`). A record that arrives later reopens it.
- Each sub-agent is a child session, labeled with its type as `agent_role`, that closes when Claude Code reports the sub-agent completed; one resumed with `SendMessage` reopens its child session. Claude Code 2.1.310 and later tags a sub-agent's log events, so `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA` is not needed: it adds traces, which Flightdeck does not store.

If no session appears, start Claude Code with `--debug-file <path>`: the log names the exporter's failures in `[3P telemetry]` lines. Under the Agent SDK, set `CLAUDE_CODE_OTEL_DIAG_STDERR=1` and read them through the SDK's `stderr` option (TypeScript) or callback (Python).

Rolling it out:

- **Across an organization**, put the variables in the `env` block of Claude Code's managed settings (a managed settings file or server-managed settings). Managed settings outrank every other source, and Claude Code 2.1.217 and later also removes a developer's own endpoint variables, so the export cannot be pointed elsewhere. Set `OTEL_SERVICE_NAME=claude-code` and `OTEL_RESOURCE_ATTRIBUTES` there too, so a repository cannot change them (above). The managed `OTEL_RESOURCE_ATTRIBUTES` replaces each machine's own, and no shell expands a settings file, so write `host.name` into each machine's managed settings file. Server-managed settings are the same on every machine, so pinning `OTEL_RESOURCE_ATTRIBUTES` there makes every session `<user>@unknown`. From Claude Code 2.1.223, managed sources merge `env` variable by variable, and `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_SERVICE_NAME` sit outside the telemetry variables that must come from one source, so server-managed settings can carry the export while each machine's own managed settings file carries `OTEL_RESOURCE_ATTRIBUTES` with its `host.name`. A token made for the rollout can be revoked on its own. Ingestion allows each token 1000 events a minute (`FLIGHTDECK_RATE_LIMIT_PER_MINUTE`, counted per replica), shared with the sensor and the plugin, so a large rollout may need a higher budget or a token per team.
- **In GitHub Actions**, `anthropics/claude-code-action` passes nine telemetry variables from the step's `env` to Claude Code: `CLAUDE_CODE_ENABLE_TELEMETRY`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_METRIC_EXPORT_INTERVAL`, `OTEL_LOGS_EXPORT_INTERVAL` and `OTEL_RESOURCE_ATTRIBUTES`. This example sends the export through them and pins the two variables a repository could set with `--settings` in `claude_args`:

  ```yaml
  - uses: anthropics/claude-code-action@v1
    env:
      CLAUDE_CODE_ENABLE_TELEMETRY: "1"
      OTEL_LOGS_EXPORTER: otlp
      OTEL_EXPORTER_OTLP_PROTOCOL: http/protobuf
      OTEL_EXPORTER_OTLP_ENDPOINT: https://flightdeck.example.com/ingest
      OTEL_EXPORTER_OTLP_HEADERS: Authorization=Bearer ${{ secrets.FLIGHTDECK_TOKEN }}
      OTEL_LOGS_EXPORT_INTERVAL: "1000"
    with:
      anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
      claude_args: |
        --settings '{"env": {"OTEL_SERVICE_NAME": "claude-code", "OTEL_RESOURCE_ATTRIBUTES": "host.name=github-actions,flightdeck.billing_mode=metered"}}'
  ```

  The run pays with an API key, hence `metered`; leave it out for `claude_code_oauth_token`. The Action also loads the repository's settings (on a pull request, the base branch's: it restores `.claude/` and `CLAUDE.md` from the base branch before Claude Code starts), which outrank the step's `env` and the `settings` input, so the repository's committed settings can set `OTEL_RESOURCE_ATTRIBUTES` and `OTEL_SERVICE_NAME` for the run. The `--settings` pin outranks them without dropping any of the repository's settings; `--setting-sources user` in `claude_args` also shuts them out, but drops the repository's CLAUDE.md, rules, skills, commands, agents and hooks too. Send any other variable, such as `OTEL_EXPORTER_OTLP_COMPRESSION`, through the `env` of the `settings` input, which the Action writes to the runner's user settings. The runner must reach your Flightdeck deployment.
- **Cloud sessions** (Claude Code on the web) read the variables from your organization's server-managed settings, which reach every cloud session except Claude Tag channel sessions. Claude Code's documentation advises against putting a credential such as the token in a cloud environment's own variables, since anyone who uses the environment can read them, and those variables are the only route to Claude Tag sessions. The session's network must reach your Flightdeck host: add its domain to the environment's allowed domains if its network access level does not cover it.
- **The TypeScript Agent SDK** runs the Claude Code CLI, which does the exporting: set the variables in the process environment, or in `options.env`, which replaces the inherited environment, so spread `process.env` into it. Anthropic's Agent SDK observability guide suggests renaming the service with `OTEL_SERVICE_NAME`; leave it unset for Flightdeck and set `flightdeck.flavor` instead. An app that pays with an API key also sets `flightdeck.billing_mode=metered`.

A proxy in front of ingestion must accept 4 MiB request bodies on `/ingest/`; the bundled nginx does, and so does the Helm chart's `values.prod.yaml` for ingress-nginx. The limit applies to the body as sent, and a gzip body may inflate to 16 MiB. With content logging on, a batch carries prompts, responses (each cut at 60 KB by default) and tool parameters, so a backlog can pass 4 MiB; the receiver then answers 413 and the exporter drops the whole batch. Add `OTEL_EXPORTER_OTLP_COMPRESSION=gzip` when capture is on.


## Agent frameworks over OpenTelemetry

Pydantic AI, Strands Agents, the OpenAI Agents SDK (through `opentelemetry-instrumentation-openai-agents-v2`) and Google ADK export OpenTelemetry GenAI spans, and the ingestion API maps them: each agent becomes a session (a sub-agent a child session), with its model calls, tokens, tool calls and hand-offs. These sessions observe only (no Stop, no token budget), land as `client_type=otlp`, and appear 3 to 30 seconds after the run ends. Set the exporter environment before the framework is imported:

```bash
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=https://flightdeck.example.com/ingest
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20ftd_..."
export OTEL_RESOURCE_ATTRIBUTES="flightdeck.flavor=my-app,host.name=$(hostname),flightdeck.capture_prompts=true"
export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true
```

Then turn on the framework's tracing:

- **Pydantic AI:** a global `TracerProvider` with an OTLP span exporter, and `Agent.instrument_all()`.
- **Strands Agents:** `StrandsTelemetry().setup_otlp_exporter()`.
- **OpenAI Agents SDK:** a global `TracerProvider` with an OTLP span exporter, and `OpenAIAgentsInstrumentor().instrument()` from `opentelemetry-instrumentation-openai-agents-v2`. The SDK also exports its traces to OpenAI by default; call `set_trace_processors([])` before `instrument()` to turn that off, as playground script 34 does (the instrumentor adds its processor to the existing ones, so calling it afterwards drops the Flightdeck export too).
- **Google ADK:** `adk web` and `adk api_server` set it up, or call `maybe_set_otel_providers()` from `google.adk.telemetry.setup`. ADK sends each model call's content as a log record on `/v1/logs`, so a setup of your own needs a logs exporter as well as a span exporter.

`flightdeck.capture_prompts=true` keeps message content, and `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` makes the OpenAI Agents instrumentation and ADK send it (Pydantic AI and Strands send it by default). `flightdeck.agent_type` (`coding` or `production`, default `production`) and `flightdeck.billing_mode` are read as for Claude Code, but the billing default here is `metered`, not Claude Code's `subscription`. Playground scripts 32 to 35 show the setup per framework. When the sensor already reports the same run, leave the exporter off: both paths count it ([#279](https://github.com/flightdeckhq/flightdeck/issues/279)).
