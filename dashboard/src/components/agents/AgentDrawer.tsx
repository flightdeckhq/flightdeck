import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Link } from "react-router-dom";
import { Activity, ListTree } from "lucide-react";
import { useFleetStore } from "@/store/fleet";
import { type AgentLink, deriveAgentLinkage } from "@/lib/relationship";
import { STATUS_LABEL, StatusDot } from "@/lib/agent-status";
import { ClientTypePill } from "@/components/facets/ClientTypePill";
import { ClientType } from "@/lib/agent-identity";
import { ClaudeCodeLogo } from "@/components/ui/claude-code-logo";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { OSIcon } from "@/components/ui/OSIcon";
import { OrchestrationIcon } from "@/components/ui/OrchestrationIcon";
import { getProvider } from "@/lib/models";
import { EventDetailDrawer } from "@/components/fleet/EventDetailDrawer";
import { SessionDrawer } from "@/components/session/SessionDrawer";
import { useAgentRuns } from "@/hooks/useAgentRuns";
import { AgentDrawerEventsTab } from "./AgentDrawerEventsTab";
import { AgentDrawerRunsTab } from "./AgentDrawerRunsTab";
import { PerAgentSwimlaneModal } from "./PerAgentSwimlaneModal";
import type { AgentEvent } from "@/lib/types";

// Mirrors SessionDrawer's slide width. The agent drawer sits at
// z-30 so the run drawer (SessionDrawer, z-40) and the event detail
// drawer (EventDetailDrawer, z-60) both stack above it.
const DRAWER_WIDTH = 520;

// Page-0 runs fetch that feeds the three header panels (MCP servers
// union, latest-run context, recent policy activity). The Runs tab
// fetches its own paginated/sorted view independently.
const PANEL_RUNS = 50;

type DrawerTab = "events" | "runs";

interface AgentDrawerProps {
  /** Agent whose drawer is open; null keeps it mounted-but-hidden so
   *  the slide-out animation can play. Driven by `?agent_drawer=`. */
  agentId: string | null;
  onClose: () => void;
  /** Re-point the drawer at another agent — used by the sub-agent
   *  linkage pills. */
  onSelectAgent: (agentId: string) => void;
}

/**
 * Right-rail agent drill-down drawer. Opened from a `/agents` row
 * click and the Fleet swimlane agent-name click via the
 * `?agent_drawer=` URL param. Header (identity, status, topology,
 * sub-agent linkage), three collapsible panels, and Events / Runs
 * tabs. A Runs row opens the run drawer stacked above; an Events
 * row opens the event detail drawer.
 */
export function AgentDrawer({
  agentId,
  onClose,
  onSelectAgent,
}: AgentDrawerProps) {
  const agents = useFleetStore((s) => s.agents);
  const flavors = useFleetStore((s) => s.flavors);

  const agent = useMemo(
    () => (agentId ? (agents.find((a) => a.agent_id === agentId) ?? null) : null),
    [agentId, agents],
  );
  const linkage = useMemo(
    () =>
      agentId
        ? deriveAgentLinkage(agentId, flavors)
        : { parent: null, children: [] },
    [agentId, flavors],
  );

  const [tab, setTab] = useState<DrawerTab>("events");
  const [selectedEvent, setSelectedEvent] = useState<AgentEvent | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [swimlaneOpen, setSwimlaneOpen] = useState(false);
  const [openPanels, setOpenPanels] = useState({
    mcp: false,
    context: false,
    policy: false,
  });

  // Reset transient state whenever the drawer re-points at a fresh
  // agent so a stale tab / nested drawer never bleeds across agents.
  useEffect(() => {
    setTab("events");
    setSelectedEvent(null);
    setSelectedRunId(null);
    setSwimlaneOpen(false);
    setOpenPanels({ mcp: false, context: false, policy: false });
  }, [agentId]);

  // Page-0 runs feeding the header panels.
  const { runs: panelRuns } = useAgentRuns(agentId, 0, PANEL_RUNS, {
    column: "started_at",
    direction: "desc",
  });

  const mcpServers = useMemo(() => {
    const seen = new Set<string>();
    for (const r of panelRuns) {
      for (const name of r.mcp_server_names ?? []) seen.add(name);
    }
    return [...seen].sort();
  }, [panelRuns]);

  const policyEventTypes = useMemo(() => {
    const seen = new Set<string>();
    for (const r of panelRuns) {
      for (const t of r.policy_event_types ?? []) seen.add(t);
    }
    return [...seen].sort();
  }, [panelRuns]);

  const latestContext = panelRuns[0]?.context ?? null;

  // Topology descriptor for the status row. Names live in row 4
  // (the linkage pills). Derived from ``linkage``, not from
  // ``agent.topology``, so depth-2 middle agents that are both a
  // parent AND a child render BOTH descriptors with a middle dot.
  //
  // The "drawer closed" guard is keyed on ``agentId`` (a stable
  // primitive) rather than ``agent`` (a useMemo-derived object
  // whose reference re-creates on every fleet WS tick that
  // mutates any field of the matched agent). The descriptor is
  // identity-stable under WS churn — only a real linkage shape
  // change re-computes.
  const topologyDescriptor = useMemo(() => {
    if (!agentId) return "";
    const parts: string[] = [];
    if (linkage.parent) parts.push("sub-agent");
    if (linkage.children.length > 0) {
      parts.push(`spawns ${linkage.children.length}`);
    }
    return parts.join(" • ");
  }, [agentId, linkage.parent, linkage.children.length]);

  const open = agent !== null;

  const model = agent?.recent_sessions?.[0]?.model ?? null;
  const provider = model ? getProvider(model) : null;

  return (
    <>
      <AnimatePresence>
        {open && agent && (
          <motion.div
            data-testid="agent-drawer"
            data-agent-id={agent.agent_id}
            className="fixed right-0 top-0 z-30 flex h-full flex-col"
            style={{
              width: DRAWER_WIDTH,
              background: "var(--surface)",
              borderLeft: "1px solid var(--border)",
            }}
            initial={{ x: DRAWER_WIDTH }}
            animate={{ x: 0 }}
            exit={{ x: DRAWER_WIDTH }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
          >
            {/* Header strip — deterministic four-row stack, each
                row its own container, no ``flex-wrap``. The
                action-link row lives separately from the
                status+topology row so a wide topology label or a
                sub-agent badge can never push the action links
                onto a wrapping line. Existing testids
                (``agent-drawer-name``, ``agent-drawer-close``,
                ``agent-drawer-open-swimlane``,
                ``agent-drawer-open-in-events``,
                ``agent-drawer-linkage``) are preserved so
                existing specs continue to pass; new per-row
                testids (``agent-drawer-header-*``) anchor T98's
                vertical-order assertions. */}
            <div
              style={{
                borderBottom: "1px solid var(--border)",
                background: "var(--bg-elevated)",
              }}
            >
              {/* Row 1 — identity + close X. */}
              <div
                data-testid="agent-drawer-header-identity"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "10px 14px",
                }}
              >
                {agent.client_type === ClientType.ClaudeCode && (
                  <ClaudeCodeLogo size={15} />
                )}
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 14,
                    fontWeight: 600,
                    color: "var(--text)",
                  }}
                  data-testid="agent-drawer-name"
                >
                  {agent.agent_name}
                </span>
                <ClientTypePill
                  clientType={agent.client_type}
                  size="compact"
                />
                <span
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: "var(--text-muted)",
                  }}
                >
                  {agent.agent_type}
                </span>
                {provider && provider !== "other" && (
                  <ProviderLogo provider={provider} size={13} />
                )}
                {typeof latestContext?.os === "string" && (
                  <OSIcon os={latestContext.os} size={13} />
                )}
                {typeof latestContext?.orchestration === "string" && (
                  <OrchestrationIcon
                    orchestration={latestContext.orchestration}
                    size={13}
                  />
                )}
                <button
                  type="button"
                  data-testid="agent-drawer-close"
                  onClick={onClose}
                  aria-label="Close agent drawer"
                  style={{
                    marginLeft: "auto",
                    background: "transparent",
                    border: "none",
                    color: "var(--text-muted)",
                    fontSize: 18,
                    lineHeight: 1,
                    cursor: "pointer",
                    padding: 2,
                  }}
                >
                  ×
                </button>
              </div>

              {/* Row 2 — status + topology descriptor. Plain
                  muted text, NOT link-styled: this row is info,
                  not navigation. The topology descriptor is
                  intentionally NAME-FREE — row 4 carries the
                  navigable pills that name the parent / children,
                  so this row stays a pure summary and there is no
                  duplication between rows for any topology shape.
                  Derived from ``linkage`` (not ``agent.topology``)
                  so depth-2 middle agents that are both children
                  AND parents read correctly. */}
              <div
                data-testid="agent-drawer-header-status"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "0 14px 8px",
                  fontSize: 11,
                  color: "var(--text-muted)",
                }}
              >
                <StatusDot
                  state={agent.state}
                  testId="agent-drawer-status-dot"
                />
                <span
                  data-testid="agent-drawer-status-label"
                  style={{ color: "var(--text)" }}
                >
                  {STATUS_LABEL[agent.state]}
                </span>
                {topologyDescriptor && (
                  <>
                    <span aria-hidden="true">|</span>
                    <span data-testid="agent-drawer-topology-descriptor">
                      {topologyDescriptor}
                    </span>
                  </>
                )}
              </div>

              {/* Row 3 — action buttons. Bordered, icon + label,
                  reads as clearly clickable. ``Open in swimlane``
                  uses the local state setter; ``Open in events``
                  is a real router Link. */}
              <div
                data-testid="agent-drawer-header-actions"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "0 14px 10px",
                }}
              >
                <button
                  type="button"
                  data-testid="agent-drawer-open-swimlane"
                  aria-label={`Open ${agent.agent_name} in swimlane`}
                  onClick={() => setSwimlaneOpen(true)}
                  style={drawerActionButtonStyle}
                >
                  <Activity size={12} aria-hidden="true" />
                  Open in swimlane
                </button>
                <Link
                  to={`/events?agent_id=${encodeURIComponent(agent.agent_id)}`}
                  data-testid="agent-drawer-open-in-events"
                  aria-label={`Open ${agent.agent_name} in events`}
                  style={{
                    ...drawerActionButtonStyle,
                    textDecoration: "none",
                  }}
                >
                  <ListTree size={12} aria-hidden="true" />
                  Open in events
                </Link>
              </div>

              {/* Row 4 (conditional) — sub-agent / parent linkage
                  sections. Labelled muted-uppercase headers so the
                  pills read as a navigation cluster, not a
                  free-floating chip strip. PARENT renders first
                  (hierarchical reading order), then SUB-AGENTS.
                  Both sections can co-exist for depth-2 middle
                  agents. Pills reuse ``.agent-status-chip`` from
                  globals.css for the hover + focus-visible
                  affordance so they read as clickable. */}
              {(linkage.parent || linkage.children.length > 0) && (
                <div
                  data-testid="agent-drawer-header-subagents"
                  style={{ padding: "0 14px 10px" }}
                >
                  <div
                    data-testid="agent-drawer-linkage"
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                    }}
                  >
                    {linkage.parent && (
                      <LinkageSection
                        label="Parent"
                        testId="agent-drawer-linkage-parent-section"
                      >
                        <LinkagePill
                          label={`← parent: ${linkage.parent.agentName}`}
                          testId="agent-drawer-parent-pill"
                          onClick={() =>
                            onSelectAgent(linkage.parent!.agentId)
                          }
                        />
                      </LinkageSection>
                    )}
                    {linkage.children.length > 0 && (
                      <LinkageSection
                        label="Sub-agents"
                        testId="agent-drawer-linkage-children-section"
                      >
                        {linkage.children.map((child: AgentLink) => (
                          <LinkagePill
                            key={child.agentId}
                            label={`↳ ${child.agentName}`}
                            testId="agent-drawer-child-pill"
                            onClick={() => onSelectAgent(child.agentId)}
                          />
                        ))}
                      </LinkageSection>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Collapsible panels */}
            <div
              style={{ borderBottom: "1px solid var(--border-subtle)" }}
              data-testid="agent-drawer-panels"
            >
              <CollapsiblePanel
                title="MCP servers"
                testId="agent-drawer-panel-mcp"
                open={openPanels.mcp}
                onToggle={() =>
                  setOpenPanels((p) => ({ ...p, mcp: !p.mcp }))
                }
              >
                {mcpServers.length === 0 ? (
                  <PanelEmpty>No MCP servers connected.</PanelEmpty>
                ) : (
                  <ChipRow items={mcpServers} />
                )}
              </CollapsiblePanel>
              <CollapsiblePanel
                title="Latest run context"
                testId="agent-drawer-panel-context"
                open={openPanels.context}
                onToggle={() =>
                  setOpenPanels((p) => ({ ...p, context: !p.context }))
                }
              >
                <ContextPanel context={latestContext} />
              </CollapsiblePanel>
              <CollapsiblePanel
                title="Recent policy events"
                testId="agent-drawer-panel-policy"
                open={openPanels.policy}
                onToggle={() =>
                  setOpenPanels((p) => ({ ...p, policy: !p.policy }))
                }
              >
                {policyEventTypes.length === 0 ? (
                  <PanelEmpty>No recent policy events.</PanelEmpty>
                ) : (
                  <ChipRow items={policyEventTypes} />
                )}
              </CollapsiblePanel>
            </div>

            {/* Tab bar */}
            <div
              style={{
                display: "flex",
                borderBottom: "1px solid var(--border)",
                background: "var(--surface)",
              }}
            >
              <TabButton
                label="Events"
                testId="agent-drawer-tab-events"
                active={tab === "events"}
                onClick={() => setTab("events")}
              />
              <TabButton
                label="Runs"
                testId="agent-drawer-tab-runs"
                active={tab === "runs"}
                onClick={() => setTab("runs")}
              />
            </div>

            {/* Tab content */}
            <div style={{ flex: 1, minHeight: 0 }}>
              {tab === "events" ? (
                <AgentDrawerEventsTab
                  agentId={agent.agent_id}
                  onEventClick={setSelectedEvent}
                  onRunClick={setSelectedRunId}
                />
              ) : (
                <AgentDrawerRunsTab
                  agentId={agent.agent_id}
                  onRunClick={setSelectedRunId}
                />
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Event detail drawer — stacks above the agent drawer.
          "View entire run →" hands off to the run drawer. */}
      <EventDetailDrawer
        event={selectedEvent}
        onClose={() => setSelectedEvent(null)}
        onViewRun={(sessionId) => {
          setSelectedEvent(null);
          setSelectedRunId(sessionId);
        }}
      />

      {/* Run drawer — the existing SessionDrawer, stacked above with a
          breadcrumb back to this agent. */}
      <SessionDrawer
        sessionId={selectedRunId}
        onClose={() => setSelectedRunId(null)}
        backLabel={agent?.agent_name}
        onBack={() => setSelectedRunId(null)}
      />

      {/* Per-agent swimlane modal — opened from the header
          "Open in swimlane" button, scoped to this agent. The modal
          is a Radix Dialog that portals to <body>, so it stacks
          above the agent drawer without z-index coordination. */}
      <PerAgentSwimlaneModal
        agent={swimlaneOpen ? agent : null}
        onClose={() => setSwimlaneOpen(false)}
      />
    </>
  );
}

// Shared style for the row-3 action buttons. Bordered, icon +
// label, reads as a primary affordance. Used by both the
// ``Open in swimlane`` ``<button>`` and the ``Open in events``
// ``<Link>`` so the two read identically.
const drawerActionButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 4,
  padding: "4px 9px",
  cursor: "pointer",
};

// Labelled wrapper around one row-4 linkage cluster. Two
// sections (Parent / Sub-agents) stack vertically inside row 4
// for depth-2 middle agents that have both. The section label
// keeps the navigation purpose explicit — the pills alone
// could read like decorative chips.
function LinkageSection({
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
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
    >
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 9,
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-muted)",
        }}
      >
        {label}
      </span>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          flexWrap: "wrap",
        }}
      >
        {children}
      </div>
    </div>
  );
}

function LinkagePill({
  label,
  testId,
  onClick,
}: {
  label: string;
  testId: string;
  onClick: () => void;
}) {
  // Reuses the shared ``.agent-status-chip`` hover + focus-
  // visible affordance from globals.css so the pill reads as
  // clearly interactive. Layout / typography / clipping live
  // here as inline styles so the chip class stays purely an
  // interactive-affordance helper. The inline ``borderRadius:
  // 999`` intentionally overrides the chip class's
  // ``border-radius: 4px`` to keep the pill capsule-shaped —
  // the chip class is a generic affordance, the pill applies
  // its own visual idiom on top.
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      className="agent-status-chip"
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: 10,
        padding: "2px 7px",
        borderRadius: 999,
        color: "var(--text-secondary)",
        maxWidth: 200,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "inline-block",
      }}
    >
      {label}
    </button>
  );
}

function TabButton({
  label,
  testId,
  active,
  onClick,
}: {
  label: string;
  testId: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active ? "true" : undefined}
      onClick={onClick}
      style={{
        flex: 1,
        padding: "8px 0",
        fontSize: 12,
        fontWeight: 600,
        background: "transparent",
        border: "none",
        borderBottom: active
          ? "2px solid var(--accent)"
          : "2px solid transparent",
        color: active ? "var(--text)" : "var(--text-muted)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

function CollapsiblePanel({
  title,
  testId,
  open,
  onToggle,
  children,
}: {
  title: string;
  testId: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId}>
      <button
        type="button"
        data-testid={`${testId}-toggle`}
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "6px 14px",
          background: "transparent",
          border: "none",
          borderTop: "1px solid var(--border-subtle)",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-secondary)",
          cursor: "pointer",
        }}
      >
        <span aria-hidden="true">{open ? "▾" : "▸"}</span>
        {title}
      </button>
      {open && <div style={{ padding: "4px 14px 10px" }}>{children}</div>}
    </div>
  );
}

function PanelEmpty({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
      {children}
    </span>
  );
}

function ChipRow({ items }: { items: string[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
      {items.map((item) => (
        <span
          key={item}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            padding: "1px 6px",
            borderRadius: 3,
            border: "1px solid var(--border-subtle)",
            color: "var(--text-secondary)",
          }}
        >
          {item}
        </span>
      ))}
    </div>
  );
}

// Context keys surfaced in the latest-run-context panel, in display
// order. Each value is coerced to a string defensively — context is
// untyped JSONB and a value may arrive as a string or an array.
const CONTEXT_KEYS: { key: string; label: string }[] = [
  { key: "os", label: "OS" },
  { key: "orchestration", label: "Orchestration" },
  { key: "frameworks", label: "Frameworks" },
  { key: "git_branch", label: "Git branch" },
  { key: "git_repo", label: "Git repo" },
  { key: "hostname", label: "Host" },
];

function ContextPanel({
  context,
}: {
  context: Record<string, unknown> | null;
}) {
  if (!context) {
    return <PanelEmpty>No runtime context for the latest run.</PanelEmpty>;
  }
  const rows = CONTEXT_KEYS.map((c) => ({
    label: c.label,
    value: coerceContextValue(context[c.key]),
  })).filter((r) => r.value !== "");
  if (rows.length === 0) {
    return <PanelEmpty>No runtime context for the latest run.</PanelEmpty>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {rows.map((r) => (
        <div key={r.label} style={{ display: "flex", gap: 8, fontSize: 11 }}>
          <span style={{ color: "var(--text-muted)", minWidth: 88 }}>
            {r.label}
          </span>
          <span
            style={{
              fontFamily: "var(--font-mono)",
              color: "var(--text)",
              wordBreak: "break-word",
            }}
          >
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function coerceContextValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.filter((v) => typeof v === "string").join(", ");
  }
  return "";
}
