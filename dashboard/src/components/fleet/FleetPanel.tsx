import { useMemo, useState } from "react";
import type { CustomDirective, FlavorSummary, FeedEvent } from "@/lib/types";
import type { ContextFacets, ContextFilters } from "@/types/context";
import { truncateSessionId, getDirectiveResultColor, getDirectiveBadge } from "@/lib/events";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SessionStateBar } from "./SessionStateBar";
import { PolicyEventList } from "./PolicyEventList";
import { createDirective } from "@/lib/api";
import { flavorHasDirectiveCapableSession } from "@/lib/directives";
import { ClaudeCodeLogo } from "@/components/ui/claude-code-logo";
import { CodingAgentBadge } from "@/components/ui/coding-agent-badge";
import { DirectiveCard } from "@/components/directives/DirectiveCard";
import { useFleetStore } from "@/store/fleet";
import { OctagonX, X, Zap } from "lucide-react";

/**
 * Per-state session counts. Computed by Fleet.tsx via useMemo from
 * the live flavors array so the SESSION STATES sidebar updates on
 * every WebSocket fleet update. (FIX 1)
 */
export interface SessionStateCounts {
  active: number;
  idle: number;
  stale: number;
  closed: number;
  lost: number;
}

interface FleetPanelProps {
  flavors: FlavorSummary[];
  /**
   * Pre-computed live session state counts. When provided, the
   * sidebar reads from this prop directly rather than recomputing
   * from flavors -- this guarantees the counts stay in sync with
   * the flavors prop on every render. Optional so existing tests
   * that pass only flavors continue to work.
   */
  sessionStateCounts?: SessionStateCounts;
  /**
   * Sum of tokens_total across every event in the currently selected
   * time range. Optional so existing tests that pre-date the scoped
   * Tokens row continue to compile -- when omitted the row shows 0.
   */
  tokensInRange?: number;
  /**
   * Currently selected time range label, used as the suffix on the
   * Tokens row label ("Tokens (1h)").
   */
  timeRange?: string;
  onFlavorClick?: (flavor: string) => void;
  activeFlavorFilter?: string | null;
  directiveEvents?: FeedEvent[];
  /**
   * Runtime context facets aggregated by the fleet API across every
   * non-terminal session. Powers the CONTEXT sidebar filter panel.
   */
  contextFacets?: ContextFacets;
  /** Currently-selected context filter values, keyed by facet name. */
  contextFilters?: ContextFilters;
  /** Toggle a single (key, value) selection. */
  onContextFilter?: (key: string, value: string) => void;
  /** Clear all context filter selections. */
  onClearContext?: () => void;
  children?: React.ReactNode;
}

export function FleetPanel({
  flavors,
  sessionStateCounts,
  tokensInRange = 0,
  timeRange,
  onFlavorClick,
  activeFlavorFilter,
  directiveEvents = [],
  contextFacets = {},
  contextFilters = {},
  onContextFilter,
  onClearContext,
  children,
}: FleetPanelProps) {
  const totalSessions = flavors.reduce((s, f) => s + f.session_count, 0);
  const totalActive = flavors.reduce((s, f) => s + f.active_count, 0);

  // Read the fleet-wide custom directive list from the store and
  // index it by flavor so each FlavorItem can show a "Directives"
  // button only when its flavor actually has directives registered.
  const customDirectives = useFleetStore((s) => s.customDirectives);
  const customDirectivesByFlavor = useMemo(() => {
    const map: Record<string, CustomDirective[]> = {};
    for (const d of customDirectives) {
      (map[d.flavor] ??= []).push(d);
    }
    return map;
  }, [customDirectives]);

  return (
    <div
      className="flex w-[240px] shrink-0 flex-col overflow-y-auto"
      style={{
        background: "var(--surface)",
        borderRight: "1px solid var(--border)",
      }}
    >
      {/* Fleet Overview */}
      <div className="px-3 pb-2 pt-4 text-xs font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--text-secondary)" }}>
        Fleet Overview
      </div>
      {/* Fleet Overview. The Tokens row is scoped to the currently
          selected time range -- the label suffix ("(1h)") makes the
          time qualifier explicit so the number can't be misread as
          an all-time fleet total. Updates automatically as the user
          changes the time range upstream because feedEvents
          repopulates from the new historical fetch. */}
      <div className="space-y-1 px-3 pb-3">
        <SidebarRow label="Agents" value={flavors.length} />
        <SidebarRow label="Sessions" value={totalSessions} />
        <SidebarRow label="Active" value={totalActive} valueColor="var(--status-active)" />
        <SidebarRow
          label={timeRange ? `Tokens (${timeRange})` : "Tokens"}
          value={tokensInRange.toLocaleString()}
        />
      </div>

      {/* Session States */}
      <div className="px-3 pb-2 pt-2 text-xs font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--text-secondary)" }}>
        Session States
      </div>
      <div className="px-3 pb-3">
        <SessionStateBar flavors={flavors} counts={sessionStateCounts} />
      </div>

      {/* Flavors */}
      <div className="px-3 pb-2 pt-2 text-xs font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--text-secondary)" }}>
        Agents
        {activeFlavorFilter && (
          <span className="ml-1 font-normal" style={{ color: "var(--primary)" }}>
            (filtered)
          </span>
        )}
      </div>
      {/* Scrollable flavor list. Caps at ~6 rows (240px) so a long
          flavor list never pushes POLICY EVENTS / DIRECTIVE ACTIVITY /
          CONTEXT off-screen below. The fade gradient at the bottom is
          a soft visual cue that there is more to scroll to -- only
          rendered when the row count actually overflows the viewport.

          flexShrink: 0 + minHeight: 80 is load-bearing: the parent
          FleetPanel is a `flex flex-col overflow-y-auto` with a
          bounded viewport height, and flex children default to
          `flex-shrink: 1`. Without these two props the flavor list
          collapses to its min-content (~1 row) whenever total
          sidebar content exceeds the viewport, because the flex
          algorithm shrinks children BEFORE the parent's overflow-y
          kicks in. Pinning `flex: "0 0 auto"` via shrink-0 keeps the
          list at its natural size (capped by maxHeight), and the
          minHeight floor guarantees at least two rows are visible
          even in the degenerate case where flex-shrink would
          otherwise win. */}
      <div
        className="thin-scrollbar pb-3"
        style={{
          overflowY: "auto",
          minHeight: 80,
          maxHeight: 240,
          flexShrink: 0,
          position: "relative",
          scrollbarWidth: "thin",
        }}
      >
        {flavors.map((f) => (
          <FlavorItem
            key={f.flavor}
            flavor={f}
            isActive={activeFlavorFilter === f.flavor}
            onFlavorClick={onFlavorClick}
            directives={customDirectivesByFlavor[f.flavor] ?? []}
          />
        ))}
        {flavors.length > 6 && (
          <div
            data-testid="flavor-list-fade"
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: 24,
              background:
                "linear-gradient(to bottom, transparent, var(--surface))",
              pointerEvents: "none",
            }}
          />
        )}
      </div>

      {/* Policy Events */}
      <div className="px-3 pb-2 pt-2 text-xs font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--text-secondary)" }}>
        Policy Events
      </div>
      <div className="px-3 pb-3">
        <PolicyEventList />
      </div>

      {/* Directive Activity -- header + body are BOTH hidden when
          there's no activity. The section only appears when there's
          something operational to show, per the cleanup request. */}
      {directiveEvents.length > 0 && (
        <>
          <div
            className="px-3 pb-2 pt-2 text-xs font-semibold uppercase tracking-[0.06em]"
            style={{ color: "var(--text-secondary)" }}
            data-testid="directive-activity-header"
          >
            Directive Activity
          </div>
          <div className="px-3 pb-3">
            <div className="space-y-0.5">
              {directiveEvents.map((fe, i) => {
              const evt = fe.event;
              const payload = evt.payload;
              const status = payload?.directive_status;
              const dotColor = getDirectiveResultColor(evt.event_type, status);

              // Top line: directive name (preferred) or directive_action,
              // falling back to a generic label so the row never reads
              // as a bare event_type.
              const topLine =
                evt.event_type === "directive_result"
                  ? payload?.directive_name ?? payload?.directive_action ?? "directive result"
                  : payload?.directive_action ?? evt.event_type;

              const badge = getDirectiveBadge(payload);

              return (
                <div
                  key={`${fe.arrivedAt}-${i}`}
                  className="flex items-center gap-2"
                  style={{ height: 32 }}
                >
                  <span
                    className="inline-block rounded-full"
                    style={{
                      width: 8,
                      height: 8,
                      background: dotColor,
                      flexShrink: 0,
                    }}
                  />
                  <div className="flex-1 min-w-0">
                    <div
                      className="font-mono text-xs truncate"
                      style={{ color: "var(--text)" }}
                    >
                      {topLine}
                    </div>
                    <div
                      className="text-[11px] truncate"
                      style={{ color: "var(--text-muted)" }}
                    >
                      {evt.flavor} · {truncateSessionId(evt.session_id)}
                      {badge && (
                        <>
                          {" · "}
                          <span
                            className="font-semibold"
                            style={{ color: badge.color, fontSize: 10 }}
                          >
                            {badge.label}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <span
                    className="font-mono text-[11px] shrink-0"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {new Date(fe.arrivedAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      second: "2-digit",
                    })}
                  </span>
                </div>
              );
            })}
            </div>
          </div>
        </>
      )}

      {/* Context facets sidebar. Only renders when at least one
          facet has 2+ distinct values -- single-value facets aren't
          useful as filters. */}
      <ContextFacetSection
        facets={contextFacets}
        filters={contextFilters}
        onToggle={onContextFilter}
        onClear={onClearContext}
      />

      {children}
    </div>
  );
}

/**
 * CONTEXT sidebar section. Renders one facet group per key in
 * contextFacets that has 2+ distinct values. Single-value facets
 * are skipped (not useful as filters).
 */
function ContextFacetSection({
  facets,
  filters,
  onToggle,
  onClear,
}: {
  facets: ContextFacets;
  filters: ContextFilters;
  onToggle?: (key: string, value: string) => void;
  onClear?: () => void;
}) {
  // Only show facets with 2+ distinct values; alphabetical key order.
  const filterableKeys = Object.keys(facets)
    .filter((k) => facets[k].length >= 2)
    .sort();

  if (filterableKeys.length === 0) return null;

  const hasActiveFilters = Object.keys(filters).length > 0;

  return (
    <>
      <div
        className="flex items-center justify-between px-3 pb-2 pt-2 text-xs font-semibold uppercase tracking-[0.06em]"
        style={{ color: "var(--text-secondary)" }}
        data-testid="fleet-panel-context"
      >
        <span>Context</span>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={onClear}
            className="flex h-4 w-4 items-center justify-center rounded hover:bg-surface-hover"
            aria-label="Clear context filters"
            data-testid="context-clear"
          >
            <X size={12} style={{ color: "var(--text-muted)" }} />
          </button>
        )}
      </div>
      <div className="pb-3">
        {filterableKeys.map((key) => {
          const values = facets[key];
          const selected = filters[key] ?? [];
          return (
            <div key={key} data-testid={`context-facet-${key}`}>
              <div
                className="flex items-center px-3"
                style={{
                  height: 28,
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--text-secondary)",
                }}
              >
                {key}
              </div>
              {values.map((entry) => {
                const isSelected = selected.includes(entry.value);
                return (
                  <div
                    key={entry.value}
                    className="flex items-center gap-2 cursor-pointer hover:bg-surface-hover"
                    style={{
                      height: 24,
                      paddingLeft: 24,
                      paddingRight: 12,
                      // Subtle accent-glow tint on selected rows so
                      // the active filter state is obvious at a
                      // glance without needing to hunt for the
                      // filled dot.
                      background: isSelected
                        ? "var(--accent-glow)"
                        : undefined,
                    }}
                    onClick={() => onToggle?.(key, entry.value)}
                    data-testid={`context-value-${key}-${entry.value}`}
                  >
                    <span
                      className="inline-block rounded-full"
                      style={{
                        width: 8,
                        height: 8,
                        flexShrink: 0,
                        background: isSelected ? "var(--accent)" : "transparent",
                        border: isSelected
                          ? "1px solid var(--accent)"
                          : "1px solid var(--border)",
                      }}
                    />
                    <span
                      className="flex-1 truncate font-mono"
                      style={{ fontSize: 12, color: "var(--text)" }}
                    >
                      {entry.value}
                    </span>
                    <span
                      className="font-mono shrink-0"
                      style={{ fontSize: 11, color: "var(--text-muted)" }}
                    >
                      {entry.count}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}

function SidebarRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string | number;
  valueColor?: string;
}) {
  return (
    <div className="flex items-center justify-between py-[5px] px-0 text-[13px]">
      <span
        style={{
          color: "var(--text-secondary)",
          // Keep labels on a single line so the new "(1h)" suffix
          // on the Tokens row never wraps. No visual change for
          // labels that already fit.
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </span>
      <span
        className="font-mono text-sm font-semibold"
        style={{ color: valueColor ?? "var(--text)" }}
      >
        {value}
      </span>
    </div>
  );
}

function FlavorItem({
  flavor,
  isActive,
  onFlavorClick,
  directives = [],
}: {
  flavor: FlavorSummary;
  isActive?: boolean;
  onFlavorClick?: (flavor: string) => void;
  /**
   * Custom directives registered for this flavor. When non-empty,
   * a "Directives" button appears alongside the optional "Stop All"
   * button and opens a dialog containing a DirectiveCard per
   * directive (each configured to target the whole flavor rather
   * than a single session).
   */
  directives?: CustomDirective[];
}) {
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [directivesDialogOpen, setDirectivesDialogOpen] = useState(false);
  const markFlavorShuttingDown = useFleetStore((s) => s.markFlavorShuttingDown);

  // "Live" sessions = active OR idle. Idle agents are still
  // killable -- they'll receive the shutdown directive on their next
  // LLM call. Stop All was previously gated on `active_count > 0`
  // which hid the button for any flavor whose sessions had all
  // momentarily transitioned to idle, even though those sessions
  // are still very much alive. Mirrors SwimLane's `liveCount`
  // calculation so the FlavorItem and the swimlane row stay in
  // sync about what counts as "running".
  const liveSessions = flavor.sessions.filter(
    (s) => s.state === "active" || s.state === "idle",
  );
  const hasLive = liveSessions.length > 0;
  const hasDirectives = directives.length > 0;
  // Hide the Stop All button when every live session of this flavor is
  // observer-only (Claude Code and every future hook-based plugin).
  // A mixed flavor keeps the button because the shutdown_flavor
  // directive will still reach whichever sessions poll for directives.
  // See DECISIONS.md D103 / dashboard/src/lib/directives.ts.
  const canStopFlavor = flavorHasDirectiveCapableSession(flavor.sessions);

  async function handleStopAll() {
    setLoading(true);
    setError(null);
    try {
      await createDirective({
        action: "shutdown_flavor",
        flavor: flavor.flavor,
        reason: "manual_fleet_kill",
        grace_period_ms: 5000,
      });
      // Mark every active/idle session of this flavor as shutting
      // down so the SessionDrawer (or any other per-session view)
      // shows the pulsing indicator immediately, before the
      // WebSocket update reflects the directive server-side.
      markFlavorShuttingDown(flavor.flavor);
      setSent(true);
      setDialogOpen(false);
      setTimeout(() => setSent(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="flex items-center justify-between cursor-pointer py-[5px] px-3 text-[13px] transition-colors hover:bg-surface-hover"
      style={
        isActive
          ? {
              borderLeft: "2px solid var(--accent)",
              background: "var(--accent-glow)",
              color: "var(--text)",
            }
          : { color: "var(--text)" }
      }
      onClick={() => onFlavorClick?.(flavor.flavor)}
    >
      <div className="flex items-center gap-2 min-w-0">
        {flavor.flavor === "claude-code" && (
          <ClaudeCodeLogo size={14} className="shrink-0" />
        )}
        <span className="font-mono truncate">{flavor.flavor}</span>
        {/* Specific pill wins: CODING AGENT identifies the tool
            category (hook-based coding agent, observer-only) and
            subsumes the more generic DEV signal. The icon rule at
            the ClaudeCodeLogo render above uses the same
            ``flavor === "claude-code"`` check so the icon and pill
            always flip together. Custom AGENT_FLAVOR overrides are
            deferred -- if that becomes common, broaden both rules
            together to ``isClaudeCodeSession(session)`` aggregated
            across ``flavor.sessions``. */}
        {flavor.flavor === "claude-code" ? (
          <CodingAgentBadge />
        ) : flavor.agent_type === "developer" ? (
          <span
            data-testid="flavor-dev-badge"
            className="rounded px-1 py-0.5 text-[11px] font-semibold uppercase"
            style={{
              background: "var(--accent-glow)",
              color: "var(--primary)",
            }}
          >
            DEV
          </span>
        ) : null}
        <span className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
          ({flavor.active_count})
        </span>
        {isActive && (
          <button
            className="ml-1 flex h-4 w-4 items-center justify-center rounded hover:bg-surface-hover"
            onClick={(e) => {
              e.stopPropagation();
              onFlavorClick?.(flavor.flavor);
            }}
            aria-label="Clear filter"
          >
            <X size={10} style={{ color: "var(--text-muted)" }} />
          </button>
        )}
      </div>
      {/* Action buttons -- icon-only so the flavor name doesn't
          truncate at the default 240px sidebar width. Both buttons
          carry a title attribute so the action is discoverable on
          hover and a data-testid for tests. */}
      <div className="flex items-center gap-1 shrink-0">
      {hasDirectives && (
        <Dialog
          open={directivesDialogOpen}
          onOpenChange={setDirectivesDialogOpen}
        >
          <DialogTrigger asChild>
            <button
              data-testid={`flavor-directives-button-${flavor.flavor}`}
              title={`Trigger directives on ${flavor.flavor}`}
              aria-label={`Trigger directives on ${flavor.flavor}`}
              className="flex h-5 w-5 items-center justify-center rounded transition-colors"
              style={{
                background: "var(--accent-glow)",
                color: "var(--accent)",
                border: "1px solid var(--accent-border)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <Zap size={11} />
            </button>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>
              Trigger directives on {flavor.flavor}
            </DialogTitle>
            <p className="text-sm text-text-muted">
              Each directive fans out to every active session of this
              agent. Parameters apply to all sessions uniformly.
            </p>
            <div className="max-h-[60vh] overflow-y-auto pt-2">
              {directives.map((d) => (
                <DirectiveCard
                  key={d.id}
                  directive={d}
                  flavor={flavor.flavor}
                />
              ))}
            </div>
            <div className="flex justify-end pt-2">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">
                  Close
                </Button>
              </DialogClose>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {hasLive && canStopFlavor && !sent && (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <button
              data-testid={`flavor-stop-all-button-${flavor.flavor}`}
              title={`Stop all sessions of ${flavor.flavor}`}
              aria-label={`Stop all sessions of ${flavor.flavor}`}
              className="flex h-5 w-5 items-center justify-center rounded transition-colors"
              style={{
                background: "rgba(239,68,68,0.15)",
                color: "var(--status-lost)",
                border: "1px solid rgba(239,68,68,0.3)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <OctagonX size={11} />
            </button>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>
              Stop all sessions of {flavor.flavor}?
            </DialogTitle>
            <p className="text-sm text-text-muted">
              All {liveSessions.length} active or idle agents of this type
              will receive a shutdown directive on their next LLM call.
            </p>
            <div className="flex justify-end gap-2 pt-4">
              <DialogClose asChild>
                <Button variant="ghost" size="sm">
                  Cancel
                </Button>
              </DialogClose>
              <Button
                size="sm"
                className="bg-[var(--danger)] text-white hover:bg-[var(--danger)]/90"
                onClick={handleStopAll}
                disabled={loading}
              >
                {loading ? "Sending..." : "Stop All"}
              </Button>
            </div>
            {error && (
              <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>
            )}
          </DialogContent>
        </Dialog>
      )}
      {sent && (
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>Directives sent</span>
      )}
      </div>
    </div>
  );
}
