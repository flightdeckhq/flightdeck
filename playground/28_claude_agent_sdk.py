"""Claude Agent SDK -- each run lands as its own ``claude_agent_sdk``
session, takes a stop and the MCP policy, and a Claude Code plugin
loaded into the run stays silent.

The SDK runs the Claude Code CLI as a subprocess that calls the model
itself, so ``flightdeck_sensor.patch()`` reports the run from the SDK's
message stream: the ``init`` message opens a session keyed by the
Claude Code session id, every assistant message is a ``post_call`` with
one ``tool_call`` per tool it used, and the result (or the client's
disconnect) closes it.

Four sections:

1. ``query()`` -- one run that lists a scratch directory with Bash.
2. ``ClaudeSDKClient`` -- two turns on one connection, one session.
3. Stop -- a shutdown issued from the API for a running ``query()``
   denies its next tool call; the session closes as
   ``directive_shutdown``.
4. MCP policy -- a flavor policy blocks the in-tree reference MCP
   server; the run's call to it is denied and ``policy_mcp_block`` lands.

Each run loads this repository's Claude Code plugin with the dev stack's
address in its environment, then checks that no ``claude_code`` session
names the run's Claude Code session id: the plugin reads
``FLIGHTDECK_SDK_OBSERVED`` and sends nothing, so the run is not counted
twice. ``setting_sources=[]`` keeps any plugin the user installed out of
the run, since an installed release may predate that variable.

Needs a Claude login (``claude auth login``) or an ``ANTHROPIC_API_KEY``
the CLI accepts; the run uses whichever the CLI picks. Exits 2 when the
SDK is not installed.
"""

from __future__ import annotations

import asyncio
import json
import sys
import urllib.error
import urllib.request
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

try:
    import claude_agent_sdk as sdk
except ImportError:
    print("SKIP: pip install 'flightdeck-sensor[claude-agent-sdk]' to run this example")
    sys.exit(2)

import flightdeck_sensor
from flightdeck_sensor import Provider
from _helpers import (
    API_TOKEN,
    API_URL,
    INGESTION_URL,
    fetch_events_for_session,
    init_sensor,
    print_result,
    wait_for_dev_stack,
)

MODEL = "claude-haiku-4-5"
FLAVOR = "playground-claude-agent-sdk"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
MCP_SERVER_NAME = "flightdeck-mcp-reference"
MCP_SERVER_MODULE = "playground._mcp_reference_server"
# The policy identity of the reference server as the run's options name
# it: the command and its arguments joined by spaces.
MCP_SERVER_URL = f"{sys.executable} -m {MCP_SERVER_MODULE}"
PLUGIN_DIR = Path(__file__).resolve().parent.parent / "plugin"
# The plugin takes the server root; the sensor's ingestion URL ends in /ingest.
PLUGIN_SERVER = INGESTION_URL.removesuffix("/ingest")
# Each run is a few model turns; a cap keeps a confused run cheap.
MAX_TURNS = 4


def _options(cwd: str) -> Any:
    return sdk.ClaudeAgentOptions(
        model=MODEL,
        cwd=cwd,
        allowed_tools=["Bash(ls:*)"],
        max_turns=MAX_TURNS,
        setting_sources=[],
        plugins=[{"type": "local", "path": str(PLUGIN_DIR)}],
        env={"FLIGHTDECK_SERVER": PLUGIN_SERVER, "FLIGHTDECK_TOKEN": API_TOKEN},
    )


def _plugin_sessions_for(sdk_session: str, since: str) -> list[str]:
    """``claude_code`` sessions the plugin opened for this SDK run. The
    plugin keeps its own session id and records the Claude Code one as
    ``context.claude_code_session_id``."""
    req = urllib.request.Request(
        f"{API_URL}/v1/sessions?client_type=claude_code&from={since}&limit=100",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        sessions = json.loads(r.read()).get("sessions", [])
    return [
        s["session_id"]
        for s in sessions
        if (s.get("context") or {}).get("claude_code_session_id") == sdk_session
    ]


def _check_session(
    label: str, sdk_session: str, started: float, *, since: str, min_calls: int
) -> None:
    events = fetch_events_for_session(
        sdk_session,
        timeout_s=30.0,
        expect_event_types=["session_start", "post_call", "session_end"],
    )
    kinds = [e["event_type"] for e in events]
    starts = [e for e in events if e["event_type"] == "session_start"]
    calls = [e for e in events if e["event_type"] == "post_call"]
    tools = [e for e in events if e["event_type"] == "tool_call"]
    problems = []
    if len(starts) != 1:
        problems.append(f"{len(starts)} session_start events")
    # Checked after the sensor's events landed; the plugin would have
    # sent its session_start before the first model call.
    plugin_sessions = _plugin_sessions_for(sdk_session, since)
    if plugin_sessions:
        problems.append(f"the plugin also reported the run: {plugin_sessions}")
    if "session_end" not in kinds:
        problems.append("no session_end")
    if len(calls) < min_calls:
        problems.append(f"{len(calls)} post_call events, want >= {min_calls}")
    if any(not c.get("has_content") for c in calls):
        problems.append("a post_call without captured content")
    if any(not c.get("tokens_input") for c in calls):
        problems.append("a post_call without input tokens")
    if not any(t.get("tool_name") == "Bash" for t in tools):
        problems.append(
            f"no Bash tool_call (tools: {[t.get('tool_name') for t in tools]})"
        )
    billing = {c.get("billing_mode") for c in calls}
    print_result(
        label,
        not problems,
        int((time.monotonic() - started) * 1000),
        f"session={sdk_session} events={kinds} billing={sorted(b or '' for b in billing)}",
    )
    if problems:
        raise AssertionError(f"{label}: {problems}")


def _require_plugin_loaded(message: Any) -> None:
    """The silence check proves nothing unless the plugin was loaded."""
    plugins = [p.get("name") for p in message.data.get("plugins") or []]
    if "flightdeck" not in plugins:
        raise AssertionError(f"the repository plugin did not load (plugins: {plugins})")


async def _query_run(cwd: str) -> str:
    sdk_session = ""
    async for message in sdk.query(
        prompt="List the files in the current directory with `ls`, then say how many there are.",
        options=_options(cwd),
    ):
        if isinstance(message, sdk.SystemMessage) and message.subtype == "init":
            _require_plugin_loaded(message)
        if isinstance(message, sdk.ResultMessage):
            sdk_session = message.session_id
    return sdk_session


def _api(method: str, path: str, body: dict[str, Any] | None = None) -> Any:
    req = urllib.request.Request(
        f"{API_URL}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": f"Bearer {API_TOKEN}",
            "Content-Type": "application/json",
        },
        method=method,
    )
    with urllib.request.urlopen(req, timeout=5) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def _stop_when_landed(sdk_session: str) -> None:
    """Issue a shutdown for the run once its session row exists."""
    deadline = time.monotonic() + 15
    while True:
        try:
            _api("GET", f"/v1/sessions/{sdk_session}")
            break
        except urllib.error.HTTPError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.3)
    _api(
        "POST",
        "/v1/directives",
        {
            "action": "shutdown",
            "session_id": sdk_session,
            "reason": "playground stop",
            "grace_period_ms": 0,
        },
    )


def _denials(message: Any) -> list[str]:
    """The text of the tool results in ``message`` that report an error."""
    out = []
    for block in getattr(message, "content", None) or []:
        if isinstance(block, sdk.ToolResultBlock) and block.is_error:
            out.append(str(block.content))
    return out


async def _stopped_run(cwd: str) -> tuple[str, list[str]]:
    sdk_session = ""
    denials: list[str] = []
    options = _options(cwd)
    options.max_turns = 10
    async for message in sdk.query(
        prompt=(
            "Run these four commands with the Bash tool, strictly one at a time: "
            "issue one tool call, wait for its result, then issue the next. "
            "Commands: `ls`, `ls -a`, `ls -l`, `ls -la`. Then summarise."
        ),
        options=options,
    ):
        if isinstance(message, sdk.SystemMessage) and message.subtype == "init":
            sdk_session = message.data["session_id"]
            await asyncio.to_thread(_stop_when_landed, sdk_session)
        denials.extend(_denials(message))
    return sdk_session, denials


async def _mcp_run(cwd: str) -> tuple[str, list[str]]:
    sdk_session = ""
    denials: list[str] = []
    options = _options(cwd)
    options.allowed_tools = [f"mcp__{MCP_SERVER_NAME}__echo"]
    options.mcp_servers = {
        MCP_SERVER_NAME: {
            "type": "stdio",
            "command": sys.executable,
            "args": ["-m", MCP_SERVER_MODULE],
            "env": {"PYTHONPATH": str(PROJECT_ROOT)},
        }
    }
    async for message in sdk.query(
        prompt=f"Call the echo tool of the {MCP_SERVER_NAME} MCP server with the text hi, then stop.",
        options=options,
    ):
        if isinstance(message, sdk.SystemMessage) and message.subtype == "init":
            sdk_session = message.data["session_id"]
        denials.extend(_denials(message))
    return sdk_session, denials


def _provision_mcp_block() -> None:
    try:
        _api("DELETE", f"/v1/mcp-policies/{FLAVOR}")
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise
    _api(
        "POST",
        f"/v1/mcp-policies/{FLAVOR}",
        {
            "block_on_uncertainty": False,
            "entries": [
                {
                    "server_url": MCP_SERVER_URL,
                    "server_name": MCP_SERVER_NAME,
                    "entry_kind": "deny",
                    "enforcement": "block",
                }
            ],
        },
    )


def _remove_mcp_policy() -> None:
    try:
        _api("DELETE", f"/v1/mcp-policies/{FLAVOR}")
    except urllib.error.HTTPError:
        pass


def _check_stop(sdk_session: str, denials: list[str], started: float) -> None:
    events = fetch_events_for_session(
        sdk_session,
        timeout_s=30.0,
        expect_event_types=["directive_result", "session_end"],
    )
    end = next((e for e in events if e["event_type"] == "session_end"), None)
    close_reason = ((end or {}).get("payload") or {}).get("close_reason")
    stopped = [d for d in denials if "Stopped by Flightdeck" in d]
    problems = []
    if close_reason != "directive_shutdown":
        problems.append(f"close_reason={close_reason!r}")
    if not any(e["event_type"] == "directive_result" for e in events):
        problems.append("no directive_result")
    if not stopped:
        problems.append(f"no tool call was denied (denials: {denials})")
    print_result(
        "a stop from the API denies the run's next tool call",
        not problems,
        int((time.monotonic() - started) * 1000),
        f"session={sdk_session} close_reason={close_reason} denied={len(stopped)}",
    )
    if problems:
        raise AssertionError(f"stop: {problems}")


def _check_mcp_block(sdk_session: str, denials: list[str], started: float) -> None:
    events = fetch_events_for_session(
        sdk_session,
        timeout_s=30.0,
        expect_event_types=["policy_mcp_block", "session_end"],
    )
    blocks = [e for e in events if e["event_type"] == "policy_mcp_block"]
    payload = (blocks[0].get("payload") or {}) if blocks else {}
    problems = []
    if not blocks:
        problems.append(
            f"no policy_mcp_block (events: {[e['event_type'] for e in events]})"
        )
    elif (
        payload.get("server_url") != MCP_SERVER_URL
        or payload.get("decision_path") != "flavor_entry"
    ):
        problems.append(f"unexpected block payload: {payload}")
    if not any(MCP_SERVER_NAME in d and "blocked" in d for d in denials):
        problems.append(
            f"the MCP call was not denied with the policy's reason (denials: {denials})"
        )
    print_result(
        "the MCP policy blocks the run's MCP call",
        not problems,
        int((time.monotonic() - started) * 1000),
        f"session={sdk_session} blocks={len(blocks)}",
    )
    if problems:
        raise AssertionError(f"mcp policy: {problems}")


async def _client_run(cwd: str) -> str:
    sdk_session = ""
    async with sdk.ClaudeSDKClient(options=_options(cwd)) as client:
        for prompt in (
            "Run `ls` here and tell me the first file name.",
            "Now say the last file name, without running anything.",
        ):
            await client.query(prompt)
            async for message in client.receive_response():
                if isinstance(message, sdk.ResultMessage):
                    sdk_session = message.session_id
    return sdk_session


def main() -> None:
    wait_for_dev_stack()
    # The sensor loads its flavor's MCP policy at init, so the policy
    # section's block entry goes in first.
    _provision_mcp_block()
    try:
        _main()
    finally:
        _remove_mcp_policy()


def _main() -> None:
    init_sensor(str(uuid.uuid4()), flavor=FLAVOR)
    flightdeck_sensor.patch(quiet=True, providers=[Provider.CLAUDE_AGENT_SDK])
    print("Claude Agent SDK")

    since = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() - 60))
    with tempfile.TemporaryDirectory(prefix="fd-sdk-") as cwd:
        for name in ("alpha.txt", "beta.txt", "gamma.txt"):
            Path(cwd, name).write_text(name)

        started = time.monotonic()
        sdk_session = asyncio.run(_query_run(cwd))
        _check_session(
            "query() run is one claude_agent_sdk session",
            sdk_session,
            started,
            since=since,
            min_calls=1,
        )

        started = time.monotonic()
        sdk_session = asyncio.run(_client_run(cwd))
        _check_session(
            "ClaudeSDKClient turns share one session",
            sdk_session,
            started,
            since=since,
            min_calls=2,
        )

        started = time.monotonic()
        sdk_session, denials = asyncio.run(_stopped_run(cwd))
        _check_stop(sdk_session, denials, started)

        started = time.monotonic()
        sdk_session, denials = asyncio.run(_mcp_run(cwd))
        _check_mcp_block(sdk_session, denials, started)

    flightdeck_sensor.teardown()


if __name__ == "__main__":
    main()
