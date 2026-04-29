"""Secondary MCP server used by the bare-SDK smoke's multi-server
attribution test.

Distinct ``name`` from the reference server so the dashboard's
MCP_SERVER facet renders two rows for one Flightdeck session and
``test_smoke_mcp.py``'s multi-server test can confirm per-event
``server_name`` attribution doesn't collapse onto a single value.

Stateless. The single tool is a pure function.

Run as a stdio MCP server::

    python -m tests.smoke.fixtures.mcp_secondary_server
"""
from __future__ import annotations

from mcp.server.fastmcp import FastMCP


_SERVER_NAME = "flightdeck-mcp-secondary"


mcp_server: FastMCP = FastMCP(
    name=_SERVER_NAME,
    instructions=(
        "Secondary MCP server for the multi-server attribution smoke. "
        "Stateless. Distinct from the reference server only in name -- "
        "useful for verifying MCP_SERVER facet attribution and the "
        "session_start.context.mcp_servers list de-duplication."
    ),
)


@mcp_server.tool(
    name="reverse",
    description=(
        "Return the input text reversed. Used by the multi-server "
        "smoke to produce a tool call that lands with this server's "
        "name on the wire."
    ),
)
def reverse(text: str) -> str:
    return text[::-1]


def main() -> None:
    mcp_server.run("stdio")


if __name__ == "__main__":
    main()
