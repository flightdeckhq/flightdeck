# OTLP fixtures

OTLP/HTTP requests a real agent exported, filtered and scrubbed, one
directory per agent version and scenario. Each scenario directory holds
the requests in the order they arrived (`NNN-<signal>.json` or `.pb`)
and a `manifest.json` that names each file's route, content type and the
encoding it was sent in (protobuf requests are stored uncompressed).

`claude-code-<version>/` is recorded by `tests/otlp/record_claude_code.py`
from `claude -p` runs with Claude Code's telemetry pointed at a local
recorder:

| Scenario | What it exercises |
|---|---|
| `bash-json-prompts` | Bash calls, one failing, over `http/json`, prompts and responses logged |
| `bash-protobuf-gzip` | the same over `http/protobuf` with gzip, prompts not logged |
| `subagent-json` | a general-purpose sub-agent that runs a Bash call |
| `mcp-json` | an MCP tool call to the in-tree reference server |
| `api-error-json` | a request for a model that does not exist |

Identity attributes (`user.email`, `user.account_uuid`,
`user.account_id`, `user.id`, `organization.id`) hold placeholders, and
records that describe the recording machine (managed settings, bundled
plugins, the user's claude.ai connectors) are dropped;
`tests/integration/test_otlp_fixtures.py` checks both. Re-record when a
new Claude Code version changes its telemetry: the script makes real
model calls, so it is run by hand, never in CI.
