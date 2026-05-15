import type { AgentSummary, SessionState } from "@/lib/types";
import type { AgentType, ClientType } from "@/lib/agent-identity";
import {
  type AgentFilterState,
  deriveFrameworkOptions,
  toggleFilterValue,
} from "@/lib/agents-filter";

const STATE_OPTIONS: SessionState[] = [
  "active",
  "idle",
  "stale",
  "lost",
  "closed",
];
const AGENT_TYPE_OPTIONS: AgentType[] = ["coding", "production"];
const CLIENT_TYPE_OPTIONS: ClientType[] = ["claude_code", "flightdeck_sensor"];
const CLIENT_TYPE_LABEL: Record<ClientType, string> = {
  claude_code: "CC",
  flightdeck_sensor: "SDK",
};

interface AgentFilterChipsProps {
  agents: AgentSummary[];
  filter: AgentFilterState;
  onChange: (next: AgentFilterState) => void;
}

interface ChipProps {
  active: boolean;
  label: string;
  onClick: () => void;
  testId: string;
}

function Chip({ active, label, onClick, testId }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      data-active={active ? "true" : "false"}
      style={{
        padding: "2px 8px",
        borderRadius: 999,
        border: "1px solid",
        borderColor: active ? "var(--accent)" : "var(--border)",
        background: active
          ? "color-mix(in srgb, var(--accent) 18%, transparent)"
          : "transparent",
        color: active ? "var(--accent)" : "var(--text-secondary)",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        cursor: "pointer",
        transition: "border-color 120ms, color 120ms, background 120ms",
      }}
    >
      {label}
    </button>
  );
}

/**
 * Multi-tier filter chips above the `/agents` table. Each chip
 * group composes AND across groups and OR within: state ∧
 * agent_type ∧ client_type ∧ framework. Clicking a chip toggles
 * its value in the active filter set; the parent owns the
 * `AgentFilterState` and re-runs `filterAgents()` on each change.
 *
 * The framework chip group is dynamic — built from the visible
 * agent set's `recent_sessions[].framework` union. If no agent
 * carries a framework value, the framework group hides entirely
 * (no empty placeholder).
 */
export function AgentFilterChips({
  agents,
  filter,
  onChange,
}: AgentFilterChipsProps) {
  const frameworkOptions = deriveFrameworkOptions(agents);

  return (
    <div
      data-testid="agent-filter-chips"
      style={{
        display: "flex",
        gap: 16,
        flexWrap: "wrap",
        padding: "8px 12px",
        borderBottom: "1px solid var(--border-subtle)",
        background: "var(--surface)",
      }}
    >
      <ChipGroup label="STATE" testId="agent-filter-state-group">
        {STATE_OPTIONS.map((s) => (
          <Chip
            key={s}
            label={s}
            active={filter.states.has(s)}
            testId={`agent-filter-state-${s}`}
            onClick={() =>
              onChange({
                ...filter,
                states: toggleFilterValue(filter.states, s),
              })
            }
          />
        ))}
      </ChipGroup>

      <ChipGroup label="AGENT TYPE" testId="agent-filter-agent-type-group">
        {AGENT_TYPE_OPTIONS.map((t) => (
          <Chip
            key={t}
            label={t}
            active={filter.agentTypes.has(t)}
            testId={`agent-filter-agent-type-${t}`}
            onClick={() =>
              onChange({
                ...filter,
                agentTypes: toggleFilterValue(filter.agentTypes, t),
              })
            }
          />
        ))}
      </ChipGroup>

      <ChipGroup label="CLIENT" testId="agent-filter-client-type-group">
        {CLIENT_TYPE_OPTIONS.map((c) => (
          <Chip
            key={c}
            label={CLIENT_TYPE_LABEL[c]}
            active={filter.clientTypes.has(c)}
            testId={`agent-filter-client-type-${c}`}
            onClick={() =>
              onChange({
                ...filter,
                clientTypes: toggleFilterValue(filter.clientTypes, c),
              })
            }
          />
        ))}
      </ChipGroup>

      {frameworkOptions.length > 0 && (
        <ChipGroup label="FRAMEWORK" testId="agent-filter-framework-group">
          {frameworkOptions.map((fw) => (
            <Chip
              key={fw}
              label={fw}
              active={filter.frameworks.has(fw)}
              testId={`agent-filter-framework-${fw}`}
              onClick={() =>
                onChange({
                  ...filter,
                  frameworks: toggleFilterValue(filter.frameworks, fw),
                })
              }
            />
          ))}
        </ChipGroup>
      )}
    </div>
  );
}

function ChipGroup({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={testId}
      style={{ display: "flex", alignItems: "center", gap: 6 }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.08em",
          color: "var(--text-muted)",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}
