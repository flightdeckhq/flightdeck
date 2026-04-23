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
