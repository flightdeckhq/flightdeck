"""A second tiny MCP server used by ``mcp_demo_multi_server.py`` to
exercise multi-server attribution. Distinct ``name`` from the
in-tree reference server so the dashboard's MCP_SERVER facet
renders two rows for one playground run.

Run as a stdio MCP server::

    python -m playground.mcp_demo_secondary_server

The demo's ``mcp_demo_multi_server.py`` spawns this module + the
in-tree ``tests.smoke.fixtures.mcp_reference_server`` over stdio,
then exercises one tool on each so the wire shape carries
attribution to two different ``server_name`` values within the
same Flightdeck session.
"""
from __future__ import annotations

from mcp.server.fastmcp import FastMCP


_SERVER_NAME = "flightdeck-mcp-secondary"


mcp_server: FastMCP = FastMCP(
    name=_SERVER_NAME,
    instructions=(
        "Flightdeck Phase 5 secondary MCP server for the multi-server "
        "demo. Stateless. Distinct from the reference server only in "
        "name — useful for verifying MCP_SERVER facet attribution and "
        "session_start.context.mcp_servers list de-duplication."
    ),
)


@mcp_server.tool(
    name="reverse",
    description="Return the input text reversed. Used by the multi-server "
    "demo to produce a tool call that lands with this server's name on "
    "the wire.",
)
def reverse(text: str) -> str:
    return text[::-1]


def main() -> None:
    mcp_server.run("stdio")


if __name__ == "__main__":
    main()
