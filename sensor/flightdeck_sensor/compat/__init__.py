"""Optional compatibility helpers for upstream framework quirks.

Each module in this package addresses one specific upstream-framework
issue Flightdeck operators hit when wiring MCP / sub-agents through
the locked-mechanism set (CrewAI, LangChain, LangGraph, LlamaIndex,
Claude Code). Helpers are opt-in — the sensor never imports them
implicitly, so an operator who isn't using the affected framework
pays nothing.

Stability: these helpers exist as workarounds for upstream bugs.
Each module's docstring names the upstream package + version where
the bug was observed and points at the README "Known framework
constraints" section. The helpers ship behind their own modules so
removing one as upstream fixes land is a clean delete + Roadmap
checkbox tick, not a sweep through the sensor proper.
"""
