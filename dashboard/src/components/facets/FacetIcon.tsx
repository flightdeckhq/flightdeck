import {
  AlertTriangle,
  Bot,
  Boxes,
  Calculator,
  CircleSlash,
  Container,
  Cpu,
  GitBranch,
  GitCommit,
  Package,
  Plug,
  Server,
  Terminal,
  User,
} from "lucide-react";
import type { ReactNode } from "react";
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

/** Shared props for the lucide category glyphs. */
const LUCIDE_PROPS = {
  size: 12,
  style: { color: "var(--text-muted)", flexShrink: 0 },
} as const;

/**
 * Resolves the icon node for a ``(groupKey, value)`` facet pair, or
 * ``null`` when the dimension carries no icon treatment. Kept as a
 * plain function (not a component) so ``FacetIcon`` can branch on
 * whether an icon exists before deciding to render a testid wrapper.
 */
function pickFacetIcon(groupKey: string, value: string): ReactNode {
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
  // Chroma dot for the POLICY / MCP POLICY facet chips. Pulls the
  // per-event-type colour from eventBadgeConfig so the sidebar
  // matches the timeline's badge chroma at a glance. Falls back
  // silently to no-icon when the event type isn't in the badge
  // config (defensive — every type in EVENT_TYPE_GROUPS has one).
  if (
    groupKey === "policy_event_type" ||
    groupKey === "mcp_policy_event_type"
  ) {
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
    return provider !== "unknown" ? (
      <ProviderLogo provider={provider} size={12} />
    ) : null;
  }
  if (groupKey === "flavor") return <Bot {...LUCIDE_PROPS} />;
  if (groupKey === "framework") return <Boxes {...LUCIDE_PROPS} />;
  // agent_type values are free-form text (coding / production today),
  // so the icon is a generic "bot" glyph; the value text carries the
  // identity.
  if (groupKey === "agent_type") return <Bot {...LUCIDE_PROPS} />;
  // Event-grain /events facets: each carries a category glyph drawn
  // from the same lucide vocabulary as the context facets above, so
  // the sidebar reads as one icon family.
  if (groupKey === "error_type") return <AlertTriangle {...LUCIDE_PROPS} />;
  if (groupKey === "mcp_server") return <Plug {...LUCIDE_PROPS} />;
  if (groupKey === "close_reason") return <CircleSlash {...LUCIDE_PROPS} />;
  if (groupKey === "estimated_via") return <Calculator {...LUCIDE_PROPS} />;
  if (groupKey === "git_branch") return <GitBranch {...LUCIDE_PROPS} />;
  if (groupKey === "hostname") return <Server {...LUCIDE_PROPS} />;
  if (groupKey === "arch") return <Cpu {...LUCIDE_PROPS} />;
  if (groupKey === "user") return <User {...LUCIDE_PROPS} />;
  if (groupKey === "process_name") return <Terminal {...LUCIDE_PROPS} />;
  if (groupKey === "node_version" || groupKey === "python_version") {
    return <Package {...LUCIDE_PROPS} />;
  }
  if (groupKey === "git_repo") return <GitCommit {...LUCIDE_PROPS} />;
  if (groupKey === "orchestration") return <Container {...LUCIDE_PROPS} />;
  return null;
}

/**
 * Icon rendered alongside a facet value row.
 *
 * Consumed by the Investigate (`/events`) facet sidebar and the Fleet
 * sidebar's CONTEXT section. The ``groupKey`` + ``value`` pair
 * determines which icon renders (see ``pickFacetIcon``); dimensions
 * with no icon treatment render nothing.
 *
 * When ``testId`` is supplied AND an icon resolves, the icon is
 * wrapped in a span carrying that testid so E2E specs can assert the
 * facet sidebar renders its icons. No wrapper (and no empty testid
 * node) is emitted when the dimension has no icon.
 */
export function FacetIcon({
  groupKey,
  value,
  testId,
}: {
  groupKey: string;
  value: string;
  testId?: string;
}) {
  const icon = pickFacetIcon(groupKey, value);
  if (!icon) return null;
  if (!testId) return <>{icon}</>;
  return (
    <span data-testid={testId} className="inline-flex shrink-0">
      {icon}
    </span>
  );
}
