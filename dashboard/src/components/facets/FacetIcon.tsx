import {
  Bot,
  Boxes,
  Container,
  Cpu,
  GitBranch,
  GitCommit,
  Package,
  Server,
  Terminal,
  User,
} from "lucide-react";
import { OSIcon } from "@/components/ui/OSIcon";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { eventBadgeConfig } from "@/lib/events";
import { getProvider } from "@/lib/models";
import { cn } from "@/lib/utils";

/**
 * Tailwind classes for the small state-dot indicator. Duplicated by
 * the row-state dot in ``Investigate.tsx`` and ``AgentTable.tsx``;
 * consolidation is a future polish step, not a phase-2 blocker.
 */
const STATE_COLORS: Record<string, string> = {
  active: "bg-status-active",
  idle: "bg-status-idle",
  stale: "bg-status-stale",
  closed: "bg-status-closed",
  lost: "bg-status-lost",
};

/**
 * Icon rendered alongside a facet value row.
 *
 * Consumed by both the Investigate sidebar (where it originated) and
 * the Fleet sidebar's CONTEXT section (previously a bare empty
 * circle). The ``groupKey`` + ``value`` pair determines which icon
 * renders:
 *
 *   - ``state`` + value → coloured dot
 *   - ``os`` + value → OS-specific icon (Linux / macOS / Windows)
 *   - ``model`` + value → provider logo (Anthropic / OpenAI / …)
 *   - flavor / framework / agent_type → generic "bot" glyph
 *   - hostname / arch / user / process_name / …_version → category icon
 *   - Unrecognised keys → null (caller decides the fallback)
 */
export function FacetIcon({
  groupKey,
  value,
}: {
  groupKey: string;
  value: string;
}) {
  if (groupKey === "state") {
    return (
      <span
        className={cn(
          "inline-block rounded-full shrink-0",
          STATE_COLORS[value] ?? "bg-text-muted",
        )}
        style={{ width: 5, height: 5 }}
      />
    );
  }
  // Step 6.7 A1: chroma dot for the POLICY and MCP POLICY facet
  // chips. Pulls the per-event-type colour from eventBadgeConfig
  // so the sidebar matches the timeline's badge chroma at a
  // glance — operators scanning facets can read "this chip
  // filters for warns" from the dot alone, without parsing the
  // label. Falls back silently to no-icon when the event type
  // isn't in the badge config (defensive — every type listed in
  // EVENT_TYPE_GROUPS has a config entry today).
  if (groupKey === "policy_event_type" || groupKey === "mcp_policy_event_type") {
    const cfg = eventBadgeConfig[value];
    if (!cfg) return null;
    return (
      <span
        className="inline-block shrink-0 rounded-full"
        style={{ width: 6, height: 6, background: cfg.cssVar }}
        aria-hidden="true"
      />
    );
  }
  if (groupKey === "os") {
    return <OSIcon os={value} size={12} />;
  }
  if (groupKey === "model") {
    const provider = getProvider(value);
    if (provider !== "unknown") {
      return <ProviderLogo provider={provider} size={12} />;
    }
    return null;
  }
  if (groupKey === "flavor") {
    return <Bot size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
  }
  if (groupKey === "framework") {
    return <Boxes size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
  }
  if (groupKey === "agent_type") {
    // agent_type values are free-form text (D114 vocabulary today --
    // coding / production -- possibly richer values tomorrow), so the
    // icon is a generic "bot" glyph rather than a per-value symbol.
    // The value text itself carries the identity.
    return <Bot size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
  }
  if (groupKey === "git_branch") {
    return <GitBranch size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
  }
  if (groupKey === "hostname") {
    return <Server size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
  }
  if (groupKey === "arch") {
    return <Cpu size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
  }
  if (groupKey === "user") {
    return <User size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
  }
  if (groupKey === "process_name") {
    return <Terminal size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
  }
  if (groupKey === "node_version" || groupKey === "python_version") {
    return <Package size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
  }
  if (groupKey === "git_repo") {
    return <GitCommit size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
  }
  if (groupKey === "orchestration") {
    return <Container size={12} style={{ color: "var(--text-muted)", flexShrink: 0 }} />;
  }
  return null;
}
