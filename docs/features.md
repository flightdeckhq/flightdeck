# Features

Each part of the dashboard and each control, in full. The [README](../README.md#what-you-get) has the short list.

**Live fleet view (`/`).** Every agent on a shared timeline, one row per agent, sub-agents indented under their parent. LLM calls, embeddings, tool uses, policy events, and structured errors plot on each agent's row as they arrive. Run boundary glyphs mark when each run started and ended. Click any event to inspect it inline.

**Agents dashboard (`/agents`).** Every agent in the fleet as a sortable row with token, latency, error rate, session count, and cost trends over the last 7 days. Filter chips narrow the table by state, agent type, client type, or framework. Click an agent for a focused drawer with that agent's runs, events, sub-agent relationships, and MCP servers. Click the status badge for a single-agent swimlane modal with its own time-range picker and sub-agent toggle.

**Events search (`/events`).** Every individual event across the fleet with facet filtering by agent, event type, error type, MCP server, framework, model, close reason, policy event type, and more. Click any event for full detail. Click the run badge to inspect the run that emitted it.

**Run inspection.** Open any run to see its events in chronological order, the token usage bar, the runtime context (git commit, k8s namespace, frameworks installed, hostname, OS), and the sub-agents it spawned. With `capture_prompts=True`, every LLM call's full payload is available: system prompt, messages, tool definitions, model response, embedding inputs. Provider shape is preserved (Anthropic sessions display `system`, `messages`, `tools`, and `response` as separate fields; OpenAI sessions display `messages` with system role included).

**Token policy enforcement.** Define token budgets centrally per flavor. Each agent pulls its policy on session start and enforces it locally with no code changes. At a configurable warn threshold (default 80% of budget) a `policy_warn` event fires and the call proceeds; at the degrade threshold (default 90%) `policy_degrade` swaps to a cheaper model; at the block threshold (default 100%) `policy_block` raises `BudgetExceededError`. Every enforcement decision is a structured event on the run timeline.

**Agent control.** Stop an individual agent or every agent of a flavor from the dashboard; the kill signal delivers on the agent's next LLM call. Register custom directives (Python functions decorated with `@flightdeck_sensor.directive`) and invoke them from the dashboard. Results land as `directive_result` events on the run timeline.

```python
@flightdeck_sensor.directive(
    name="clear_cache",
    description="Clear the prompt cache",
    parameters=[
        flightdeck_sensor.Parameter(
            name="cache_type",
            type="string",
            options=["all", "prompt"],
            default="all",
        )
    ],
)
def clear_cache(context, cache_type="all"):
    return {"cleared": my_cache.clear(cache_type)}
```

**MCP server policy.** Per-flavor allowlist or blocklist of MCP servers your agents can talk to. The sensor enforces at every MCP call; misconfigured or unrecognized servers either warn or block per the policy. See [MCP Protection Policy](mcp-protection-policy.md).

**Analytics (`/analytics`).** Token consumption, run counts, latency, model distribution, policy event volume, and estimated cost on a shared time range, grouped by any of: flavor, model, framework, host, agent_type, team, provider, agent_role, parent_session_id.

**Estimated cost.** Per-run cost computed from public list prices, accounting for cache reads and cache creation. Prices come from a vendored copy of litellm's price list, with your own overrides in [`pricing.yaml`](../pricing.yaml). Treat as a sanity check, not an invoice.
