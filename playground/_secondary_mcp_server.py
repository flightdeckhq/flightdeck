"""Secondary MCP server for the playground multi-server scenario.

Distinct ``name`` from the in-tree reference server so the dashboard's
MCP_SERVER facet renders two rows for one playground run, and the
multi-server demo in ``13_mcp.py`` can verify per-event ``server_name``
attribution against a known second value.

Underscore prefix marks this as a playground utility module, not a
numbered demo file -- ``run_all.py`` globs ``[0-9]*.py`` and skips this
file. Kept as its own module (rather than folded into ``_helpers.py``)
because it is a runnable ``python -m`` entry point and bundling that
into the helpers module would smear concerns.

Run as a stdio MCP server::

    python -m playground._secondary_mcp_server
"""
from __future__ import annotations

from mcp.server.fastmcp import FastMCP


_SERVER_NAME = "flightdeck-mcp-secondary"


mcp_server: FastMCP = FastMCP(
    name=_SERVER_NAME,
    instructions=(
        "Secondary MCP server for the playground's multi-server demo. "
        "Stateless. Distinct from the reference server only in name -- "
        "useful for verifying MCP_SERVER facet attribution and the "
        "session_start.context.mcp_servers list de-duplication."
    ),
)


@mcp_server.tool(
    name="reverse",
    description=(
        "Return the input text reversed. Used by the multi-server "
        "demo to produce a tool call that lands with this server's "
        "name on the wire."
    ),
)
def reverse(text: str) -> str:
    return text[::-1]


def main() -> None:
    mcp_server.run("stdio")


if __name__ == "__main__":
    main()
