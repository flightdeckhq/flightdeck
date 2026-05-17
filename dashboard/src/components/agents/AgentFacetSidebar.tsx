import type { ReactNode } from "react";
import type { AgentSummary, SessionState } from "@/lib/types";
import { type AgentType, type ClientType } from "@/lib/agent-identity";
import {
  type AgentFilterState,
  agentFrameworks,
  deriveFrameworkOptions,
  toggleFilterValue,
} from "@/lib/agents-filter";
import { FacetIcon } from "@/components/facets/FacetIcon";
import { AgentTypeBadge } from "@/components/facets/AgentTypeBadge";
import { ClientTypePill } from "@/components/facets/ClientTypePill";
import { FrameworkPill } from "@/components/facets/FrameworkPill";

/**
 * Fixed width of the `/agents` facet sidebar. No resize handle —
 * the sidebar carries four short facet groups, so a static width
 * matching the `/events` sidebar's resting width keeps the page
 * shell predictable without the extra resize affordance.
 */
export const AGENT_FACET_SIDEBAR_WIDTH = 248;

const STATE_OPTIONS: SessionState[] = [
  "active",
  "idle",
  "stale",
  "lost",
  "closed",
];
const AGENT_TYPE_OPTIONS: AgentType[] = ["coding", "production"];
const CLIENT_TYPE_OPTIONS: ClientType[] = ["claude_code", "flightdeck_sensor"];

interface AgentFacetSidebarProps {
  agents: AgentSummary[];
  filter: AgentFilterState;
  onChange: (next: AgentFilterState) => void;
}

/**
 * Left-side facet sidebar for the `/agents` table — the same
 * visual pattern as the `/events` (`Investigate.tsx`) sidebar.
 * Renders four facet groups: STATE, AGENT TYPE, CLIENT,
 * FRAMEWORK. Each group composes AND across groups and OR within:
 * state ∧ agent_type ∧ client_type ∧ framework. Clicking an entry
 * toggles its value in the active filter set; the parent owns the
 * `AgentFilterState` and re-runs `filterAgents()` on each change.
 *
 * Each entry shows its dimension icon, the value label, and an
 * absolute client-side count — the number of `agents` carrying
 * that value across the full (unfiltered) roster.
 *
 * The FRAMEWORK group is dynamic — built from the agent set's
 * `recent_sessions[].framework` union. If no agent carries a
 * framework value, the group hides entirely (no empty
 * placeholder).
 */
export function AgentFacetSidebar({
  agents,
  filter,
  onChange,
}: AgentFacetSidebarProps) {
  const frameworkOptions = deriveFrameworkOptions(agents);

  // Absolute per-value counts across the full roster. Each map is
  // keyed by the dimension value; FRAMEWORK counts an agent once
  // per distinct framework on its recent sessions.
  const stateCounts = countBy(agents, (a) => [a.state]);
  const agentTypeCounts = countBy(agents, (a) => [a.agent_type]);
  const clientTypeCounts = countBy(agents, (a) => [a.client_type]);
  const frameworkCounts = countBy(agents, (a) => agentFrameworks(a));

  return (
    <div
      data-testid="agents-facet-sidebar"
      className="relative flex-shrink-0 overflow-y-auto"
      style={{
        width: AGENT_FACET_SIDEBAR_WIDTH,
        borderRight: "1px solid var(--border-subtle)",
        background: "var(--surface)",
      }}
    >
      <FacetGroup label="STATE" testId="agent-filter-state-group" first>
        {STATE_OPTIONS.map((s) => (
          <FacetEntry
            key={s}
            testId={`agent-filter-state-${s}`}
            active={filter.states.has(s)}
            count={stateCounts.get(s) ?? 0}
            label={
              <FacetIcon
                groupKey="state"
                value={s}
                testId={`agent-facet-icon-state-${s}`}
              />
            }
            text={s}
            onClick={() =>
              onChange({
                ...filter,
                states: toggleFilterValue(filter.states, s),
              })
            }
          />
        ))}
      </FacetGroup>

      <FacetGroup label="AGENT TYPE" testId="agent-filter-agent-type-group">
        {AGENT_TYPE_OPTIONS.map((t) => (
          <FacetEntry
            key={t}
            testId={`agent-filter-agent-type-${t}`}
            active={filter.agentTypes.has(t)}
            count={agentTypeCounts.get(t) ?? 0}
            label={
              <AgentTypeBadge
                agentType={t}
                testId={`agent-facet-icon-agent_type-${t}`}
              />
            }
            onClick={() =>
              onChange({
                ...filter,
                agentTypes: toggleFilterValue(filter.agentTypes, t),
              })
            }
          />
        ))}
      </FacetGroup>

      <FacetGroup label="CLIENT" testId="agent-filter-client-type-group">
        {CLIENT_TYPE_OPTIONS.map((c) => (
          <FacetEntry
            key={c}
            testId={`agent-filter-client-type-${c}`}
            active={filter.clientTypes.has(c)}
            count={clientTypeCounts.get(c) ?? 0}
            label={
              <ClientTypePill
                clientType={c}
                size="compact"
                testId={`agent-facet-icon-client_type-${c}`}
              />
            }
            onClick={() =>
              onChange({
                ...filter,
                clientTypes: toggleFilterValue(filter.clientTypes, c),
              })
            }
          />
        ))}
      </FacetGroup>

      {frameworkOptions.length > 0 && (
        <FacetGroup label="FRAMEWORK" testId="agent-filter-framework-group">
          {frameworkOptions.map((fw) => (
            <FacetEntry
              key={fw}
              testId={`agent-filter-framework-${fw}`}
              active={filter.frameworks.has(fw)}
              count={frameworkCounts.get(fw) ?? 0}
              label={
                <FrameworkPill
                  framework={fw}
                  testId={`agent-facet-icon-framework-${fw}`}
                />
              }
              onClick={() =>
                onChange({
                  ...filter,
                  frameworks: toggleFilterValue(filter.frameworks, fw),
                })
              }
            />
          ))}
        </FacetGroup>
      )}
    </div>
  );
}

/**
 * Tally how many agents carry each value. `valuesOf` returns the
 * value(s) an agent contributes (one for single-value dimensions,
 * zero-or-more for FRAMEWORK). An agent is counted at most once
 * per distinct value it carries.
 */
function countBy(
  agents: AgentSummary[],
  valuesOf: (a: AgentSummary) => string[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const a of agents) {
    for (const v of new Set(valuesOf(a))) {
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
  }
  return counts;
}

function FacetGroup({
  label,
  testId,
  first,
  children,
}: {
  label: string;
  testId: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <div data-testid={testId}>
      <div
        className="font-semibold uppercase"
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          color: "var(--text-muted)",
          padding: first ? "12px 12px 6px 12px" : "16px 12px 6px 12px",
        }}
      >
        {label}
      </div>
      {children}
    </div>
  );
}

function FacetEntry({
  testId,
  active,
  count,
  label,
  text,
  onClick,
}: {
  testId: string;
  active: boolean;
  count: number;
  /** The dimension's icon or pill — the visual identity of the
   *  value. */
  label: ReactNode;
  /** Optional text that follows the icon. Omitted when the pill /
   *  badge itself IS the label (AGENT TYPE, CLIENT, FRAMEWORK). */
  text?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-active={active ? "true" : "false"}
      // Hover tint is a declarative Tailwind variant keyed on
      // data-active — no DOM-style mutation in event handlers. The
      // active fill is the inline `background` below (it always wins
      // over the hover class, so an active entry never tints on
      // hover).
      className="flex w-full items-center cursor-pointer transition-colors duration-150 hover:data-[active=false]:bg-[var(--bg-elevated)]"
      style={{
        fontSize: 13,
        padding: "4px 12px",
        borderRadius: 4,
        color: active ? "var(--primary)" : "var(--text)",
        background: active
          ? "color-mix(in srgb, var(--primary) 15%, transparent)"
          : undefined,
      }}
    >
      <span
        className="flex items-center min-w-0 flex-1"
        style={{ gap: 8 }}
      >
        {label}
        {text && <span className="truncate">{text}</span>}
      </span>
      <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{count}</span>
    </button>
  );
}
