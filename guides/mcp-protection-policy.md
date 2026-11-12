# MCP Protection Policy

The operator's view of the policy: what it gates, how it resolves and how it is configured. [ARCHITECTURE.md](../ARCHITECTURE.md) ("MCP Protection Policy") has the data model, the API and the enforcement protocol.

Flightdeck can gate which MCP servers your agents are allowed to talk to. The policy lives in the control plane, applies per flavor, and is enforced inside the sensor and the Claude Code plugin without changing the wire path.

## Why this exists

MCP servers are external code your agents call. A misconfigured `.mcp.json`, a typo'd hostname, a colleague's experimental server, or a substituted binary all reach the agent the same way: as a server entry the agent dials at session start. The MCP Protection Policy is the fence around that.

## Scope and resolution

The policy lives at two scopes: one **global** policy carrying the mode (allowlist or blocklist) plus a list of entries, and zero or more **per-flavor** policies carrying allow / deny entry deltas against the global.

On install, Flightdeck auto-creates an empty global policy in `blocklist` mode with zero entries (fully permissive by default). No operator action is required for MCP traffic to keep flowing on a fresh deployment; locking down a flavor is opt-in.

Per-server resolution: most-specific scope wins. If the per-flavor policy has an entry for the URL, use it; else if the global policy has an entry, use it; else apply the global mode default (allowlist blocks unknown, blocklist allows unknown).

Server identity is the canonical URL (or stdio command): entries match on it whatever name the server reports, and when a scope has several entries for one URL the most restrictive wins. The name is the display label and tamper-evidence axis; the displayed fingerprint is `sha256(canonical_url + 0x00 + name)`.

## Configuration

Operators create a flavor policy in the dashboard under **Policies → MCP Protection**. The Python sensor fetches the active policy at `init()` (synchronous, alongside the existing token-policy preflight). The Claude Code plugin fetches at every `SessionStart` with a one-hour disk cache.

Per-call enforcement:

- **warn** decisions emit `policy_mcp_warn` and proceed.
- **block** decisions emit `policy_mcp_block`, flush the event queue, and raise `flightdeck.MCPPolicyBlocked`. Frameworks surface this as a tool-call failure to the agent's reasoning loop.

A `policy_update` directive received in a response envelope refreshes the sensor cache; the new policy applies at the next `session_start`. In-flight sessions keep the policy that was active at their start.
