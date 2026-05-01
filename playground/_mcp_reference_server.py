"""Reference MCP server used by playground demos and the dashboard
fixture-freeze step.

DESIGN NOTE
===========
This server is **stateless** and safe to share across runs:

* Every tool is a pure function (``echo``, ``add``, ``slow_echo``).
  None of them touch module globals or persist anything.
* The single resource (``mem://demo``) returns a fixed text payload.
* The single prompt (``greet``) renders deterministically from the
  ``name`` argument.

If a future demo needs to mutate server state (e.g. test write
semantics), that demo should run its own server module rather than
promoting this server to mutable. Keeping THIS server stateless is
what makes the shared-fixture pattern safe.

USAGE
=====
Run as a stdio MCP server::

    python -m playground._mcp_reference_server

Playground scripts connect via the helper factory in
``playground/_helpers.py``::

    from _helpers import mcp_server_params
    from mcp.client.session import ClientSession
    from mcp.client.stdio import stdio_client

    params = mcp_server_params("playground._mcp_reference_server")
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            ...

The reference server is intentionally tiny — its purpose is to drive
the sensor's MCP interceptor through every patched code path with
deterministic, inspectable output. Real-world MCP servers (filesystem,
github, sqlite, ...) are exercised by user code; this fixture is for
the schema-and-fingerprint contract.
"""

from __future__ import annotations

import asyncio
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.prompts import base as prompt_base


# Server identity. The name surfaces on session_start.context.mcp_servers
# in the dashboard, so it should be stable, recognisable, and unique to
# this fixture (so a real server with the same name does not collide).
# The reported ``version`` is filled in by the FastMCP layer at handshake
# time from the installed ``mcp`` package version — this fixture does
# not pin a server version of its own. The dashboard's MCP_SERVER facet
# treats the version as informational only.
_SERVER_NAME = "flightdeck-mcp-reference"


mcp_server: FastMCP = FastMCP(
    name=_SERVER_NAME,
    instructions=(
        "Flightdeck reference MCP server. Three demo tools "
        "(echo, add, slow_echo), one demo resource (mem://demo), one "
        "demo prompt (greet). Stateless. Safe to share across tests."
    ),
)


# ---------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------


@mcp_server.tool(
    name="echo",
    description="Return the input text verbatim. Smallest possible tool — "
    "smoke tests use it to assert call_tool round-trips and dashboard "
    "fixture-freeze captures the canonical payload shape.",
)
def echo(text: str) -> str:
    return text


@mcp_server.tool(
    name="add",
    description="Add two integers. Used by smoke tests to assert that "
    "structured argument capture (capture_prompts=True) round-trips "
    "non-string types correctly.",
)
def add(a: int, b: int) -> int:
    return a + b


@mcp_server.tool(
    name="slow_echo",
    description="Echo with an artificial delay. Used by smoke tests to "
    "assert that ``duration_ms`` on MCP_TOOL_CALL events tracks the "
    "real call latency, not just zero.",
)
async def slow_echo(text: str, delay_ms: int = 25) -> str:
    # Bound the delay so a runaway argument cannot stall a smoke run.
    bounded = max(0, min(delay_ms, 5000))
    await asyncio.sleep(bounded / 1000.0)
    return text


# ---------------------------------------------------------------------
# Resource
# ---------------------------------------------------------------------


@mcp_server.resource(
    "mem://demo",
    name="demo",
    description="A static text resource. Read by smoke tests to assert "
    "MCP_RESOURCE_READ event shape: resource_uri, content_bytes "
    "(always), mime_type + content (capture_prompts=True only).",
    mime_type="text/plain",
)
def demo_resource() -> str:
    return "hello from the flightdeck reference MCP server"


# ---------------------------------------------------------------------
# Prompt
# ---------------------------------------------------------------------


@mcp_server.prompt(
    name="greet",
    description="Return a two-message conversation that greets the named "
    "user. Smoke tests assert MCP_PROMPT_GET arguments + rendered "
    "messages survive the round-trip.",
)
def greet_prompt(name: str = "world") -> list[Any]:
    return [
        prompt_base.UserMessage(content=f"Please greet {name}."),
        prompt_base.AssistantMessage(content=f"Hello, {name}!"),
    ]


# ---------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------


def main() -> None:
    """Run the server on stdio.

    The mcp SDK's FastMCP.run() method dispatches on the transport
    name. ``"stdio"`` runs over the calling process's stdin/stdout
    pipes — required for ``stdio_client(StdioServerParameters(command=
    sys.executable, args=["-m", "playground._mcp_reference_server"]))``
    to work. Other transports (sse, streamable-http) are out of scope
    for this fixture.
    """
    mcp_server.run("stdio")


if __name__ == "__main__":
    main()
