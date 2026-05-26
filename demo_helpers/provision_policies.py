"""Provision the TOKEN policy and MCP Protection Policy for the demo.

* Global TOKEN policy with aggressive thresholds so warn/degrade/block
  fire visibly across all LLM-using playground sessions within the
  10-15s recording window.
* Per-flavor MCP Protection Policies for the flavor-override values
  used by 13_mcp.py (mcp-explorer) and 19_mcp_policy_block.py
  (pii-redactor), denying the in-tree flightdeck-mcp-reference server.

13_mcp's flavor will let initialize/list_tools succeed (those go
through unmodified) but call_tool("echo", ...) trips the block.
That gives a mix of mcp_tool_list (allowed) + policy_mcp_block on
the production side.

For coding-side mcp_block, sub-agents will spawn
python -m playground.19_mcp_policy_block via Bash — that script
provisions its own (different) flavor block policy internally.

idempotent: deletes any prior policy with the same scope/flavor
before posting fresh.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

API = "http://localhost:4000/api"
TOK = "tok_dev"
AUTH = {"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"}


def _api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers=AUTH)
    raw = urllib.request.urlopen(req, timeout=5).read()
    return json.loads(raw) if raw else None


def _delete_quiet(path):
    try:
        _api("DELETE", path)
    except urllib.error.HTTPError as e:
        if e.code != 404:
            raise


LLM_FLAVORS = [
    "checkout-orchestrator",   # 01_direct_anthropic
    "research-assistant",      # 02_direct_openai
    "ingest-pipeline",         # 03_langchain
    "data-cleanup-worker",     # 04_langgraph
    "weekly-digest",           # 05_llamaindex
    "support-triage",          # 06_crewai
    "cost-monitor",            # 12_litellm
    "multi-step-research",     # 17_subagents_langgraph
]


def provision_token_policies():
    """Per-flavor TOKEN policies. Scoping to each demo flavor keeps
    the policy off of my own claude-code parent session (which has
    1.7M+ accumulated tokens and would block instantly under any
    aggressive global threshold).

    Aggressive thresholds tuned so LLM-emitting scripts trip
    WARN/DEGRADE/BLOCK within the 10-15s window:
      token_limit=300
      warn_at_pct=10  → trips at 30 tokens (~end of first call)
      degrade_at_pct=30 → trips at 90 tokens
      block_at_pct=70 → trips at 210 tokens

    The crewai / langchain / langgraph scripts burn 100+ tokens
    per call so they hit DEGRADE / BLOCK fast and the next call
    raises BudgetExceededError.
    """
    # Best-effort cleanup of any prior policies (skip if list endpoint
    # is unavailable — the demo cares about idempotent POSTs below).

    for flavor in LLM_FLAVORS:
        policy = _api("POST", "/v1/policies", {
            "scope": "flavor",
            "scope_value": flavor,
            "token_limit": 300,
            "warn_at_pct": 10,
            "degrade_at_pct": 30,
            "block_at_pct": 70,
        })
        print(f"  TOKEN policy {policy['id'][:8]} flavor={flavor!r} "
              f"limit=300 warn@10% degrade@30% block@70%")


def provision_mcp_policy(flavor, server_url, server_name):
    """Flavor-scoped MCP Protection Policy with a deny+block entry."""
    _delete_quiet(f"/v1/mcp-policies/{flavor}")
    _api("POST", f"/v1/mcp-policies/{flavor}", {
        "block_on_uncertainty": False,
        "entries": [{
            "server_url": server_url,
            "server_name": server_name,
            "entry_kind": "deny",
            "enforcement": "block",
        }],
    })
    print(f"  MCP policy flavor={flavor!r} deny+block on {server_name!r}")


def main():
    print("[provision] starting...")
    provision_token_policies()
    # 13_mcp.py (with DEMO_FLAVOR_OVERRIDE=mcp-explorer) will call
    # echo on the reference server. The reference server identity is
    # `python -m playground._mcp_reference_server` /
    # flightdeck-mcp-reference.
    reference_url = f"{sys.executable} -m playground._mcp_reference_server"
    provision_mcp_policy("mcp-explorer", reference_url,
                         "flightdeck-mcp-reference")
    print("[provision] done.")


if __name__ == "__main__":
    main()
