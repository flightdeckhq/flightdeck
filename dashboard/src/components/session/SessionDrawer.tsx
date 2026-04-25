import { Fragment, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, FileText } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedText } from "@/components/ui/TruncatedText";
import { invalidateSessionCache, useSession } from "@/hooks/useSession";
import { useFleetStore } from "@/store/fleet";
import { DirectiveCard } from "@/components/directives/DirectiveCard";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { TokenUsageBar } from "./TokenUsageBar";
import { PromptViewer } from "./PromptViewer";
import { ErrorEventDetails } from "./ErrorEventDetails";
import { createDirective, fetchOlderEvents } from "@/lib/api";
import { sessionSupportsDirectives } from "@/lib/directives";
import { ClaudeCodeLogo } from "@/components/ui/claude-code-logo";
import { CodingAgentBadge } from "@/components/ui/coding-agent-badge";
import { getClaudeCodeVersion, isClaudeCodeSession } from "@/lib/models";
import { attachBadge, getBadge, getEventDetail, getSummaryRows, isAttachmentStartEvent, truncateSessionId } from "@/lib/events";
import { getProvider } from "@/lib/models";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { OSIcon } from "@/components/ui/OSIcon";
import {
  OrchestrationIcon,
  getOrchestrationLabel,
} from "@/components/ui/OrchestrationIcon";
import { SyntaxJson } from "@/components/ui/syntax-json";
import { eventsCache } from "@/hooks/useSessionEvents";
import type { AgentEvent, Session as SessionType } from "@/lib/types";

export type DrawerTab = "timeline" | "prompts" | "directives";

// D113 drawer pagination. Flat pill selector (mirrors Fleet's time-range
// pills at Fleet.tsx:492-515) in place of a dropdown so the control
// reads as inline chrome rather than a form field. Default 100 matches
// the Supervisor-approved initial cap; 50 gives operators a lighter
// option on very dense sessions.
export const EVENTS_LIMIT_OPTIONS = [50, 100] as const;
export const DEFAULT_EVENTS_LIMIT: (typeof EVENTS_LIMIT_OPTIONS)[number] = 100;

/* ---- State badge colors ---- */

const stateBadgeStyles: Record<string, { bg: string; color: string; border: string }> = {
  active: {
    bg: "color-mix(in srgb, var(--status-active) 15%, transparent)",
    color: "var(--status-active)",
    border: "color-mix(in srgb, var(--status-active) 30%, transparent)",
  },
  idle: {
    bg: "color-mix(in srgb, var(--status-idle) 15%, transparent)",
    color: "var(--status-idle)",
    border: "color-mix(in srgb, var(--status-idle) 30%, transparent)",
  },
  stale: {
    bg: "color-mix(in srgb, var(--status-stale) 15%, transparent)",
    color: "var(--status-stale)",
    border: "color-mix(in srgb, var(--status-stale) 30%, transparent)",
  },
  closed: {
    bg: "color-mix(in srgb, var(--status-closed) 15%, transparent)",
    color: "var(--status-closed)",
    border: "color-mix(in srgb, var(--status-closed) 30%, transparent)",
  },
  lost: {
    bg: "color-mix(in srgb, var(--status-lost) 15%, transparent)",
    color: "var(--status-lost)",
    border: "color-mix(in srgb, var(--status-lost) 30%, transparent)",
  },
};

function formatDuration(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Strip a trailing 8-digit YYYYMMDD release-date suffix from a model
 * name. "claude-haiku-4-5-20251001" → "claude-haiku-4-5". Names that
 * don't end in a date (e.g. "claude-sonnet-4-6") are returned
 * unchanged. Used by the metadata-bar Model field so the value column
 * stays narrow.
 */
function truncateModel(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

/**
 * Read a typed string field off a session.context dict. Returns null
 * for missing / non-string values so callers can use ?? "—" without
 * leaking "undefined" or "[object Object]" into the UI.
 */
function ctxString(
  context: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const v = context?.[key];
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Build the ordered list of (key, value) rows shown in the RUNTIME
 * panel from a session.context object. Combines git/kubernetes/
 * compose/frameworks fields into single readable rows; everything
 * else falls through in the documented display order, with unknown
 * keys appended alphabetically at the end.
 */
function buildRuntimeRows(
  context: Record<string, unknown>,
): Array<{ key: string; value: string }> {
  const rows: Array<{ key: string; value: string }> = [];
  const seen = new Set<string>();

  const isEmpty = (v: unknown) =>
    v === undefined || v === null || v === "";

  const add = (key: string, value: unknown) => {
    if (isEmpty(value)) return;
    rows.push({ key, value: String(value) });
    seen.add(key);
  };

  const addCombined = (
    key: string,
    parts: unknown[],
    sep: string,
    consumeKeys: string[],
  ) => {
    consumeKeys.forEach((k) => seen.add(k));
    const filtered = parts.filter((p) => !isEmpty(p)).map(String);
    if (filtered.length === 0) return;
    rows.push({ key, value: filtered.join(sep) });
  };

  // Documented display order — bare fields first.
  add("hostname", context.hostname);
  add("user", context.user);
  add("process_name", context.process_name);
  add("os", context.os);
  add("arch", context.arch);
  add("python_version", context.python_version);

  // git: '{commit} · {branch} · {repo}'
  addCombined(
    "git",
    [context.git_commit, context.git_branch, context.git_repo],
    " · ",
    ["git_commit", "git_branch", "git_repo"],
  );

  add("orchestration", context.orchestration);

  // kubernetes: '{namespace} / {node}'
  addCombined(
    "kubernetes",
    [context.k8s_namespace, context.k8s_node],
    " / ",
    ["k8s_namespace", "k8s_node"],
  );

  // compose: '{project} / {service}'
  addCombined(
    "compose",
    [context.compose_project, context.compose_service],
    " / ",
    ["compose_project", "compose_service"],
  );

  // frameworks: array joined by ", "
  if (Array.isArray(context.frameworks)) {
    const joined = (context.frameworks as unknown[])
      .filter((f) => !isEmpty(f))
      .map(String)
      .join(", ");
    if (joined) rows.push({ key: "frameworks", value: joined });
    seen.add("frameworks");
  } else if (!isEmpty(context.frameworks)) {
    add("frameworks", context.frameworks);
  }

  // Anything else, alphabetical.
  const remaining = Object.keys(context)
    .filter((k) => !seen.has(k))
    .sort();
  for (const k of remaining) {
    add(k, context[k]);
  }

  return rows;
}

/* ---- Main component ---- */

interface SessionDrawerProps {
  sessionId: string | null;
  onClose: () => void;
  directEventDetail?: AgentEvent | null;
  onClearDirectEvent?: () => void;
  version?: number;
  /**
   * Tab to show when the drawer opens. Re-applied whenever sessionId
   * or initialTab changes, so callers (e.g. the Investigate camera
   * icon) can deep-link directly into the Prompts tab without the
   * user having to switch from Timeline manually.
   */
  initialTab?: DrawerTab;
}

export function SessionDrawer({ sessionId, onClose, directEventDetail, onClearDirectEvent, version = 0, initialTab }: SessionDrawerProps) {
  // Page-size pill state. Resets to DEFAULT_EVENTS_LIMIT on every
  // drawer open (no localStorage per Supervisor directive for v0.3.0)
  // so a user tuning down to 50 on one session doesn't silently carry
  // the cap across to the next drawer.
  const [eventsLimit, setEventsLimit] = useState<number>(DEFAULT_EVENTS_LIMIT);
  useEffect(() => {
    if (sessionId) setEventsLimit(DEFAULT_EVENTS_LIMIT);
  }, [sessionId]);

  // has_more flag derived from pagination fetches; seeded to true when
  // the initial capped fetch returns exactly ``eventsLimit`` rows (a
  // reasonable signal that older history may exist). Turns false when
  // the most recent fetchOlderEvents call reports has_more=false.
  const [hasMoreOlder, setHasMoreOlder] = useState<boolean>(true);
  const [loadingOlder, setLoadingOlder] = useState<boolean>(false);
  // Version counter bumped after a "Show older" merge so the
  // cache-backed useMemo below re-reads eventsCache. Separate from
  // the Fleet-injected ``version`` prop so the two sources of live
  // updates cannot clobber each other's bumps.
  const [paginationVersion, setPaginationVersion] = useState(0);

  const { data, loading } = useSession(sessionId, eventsLimit);
  const customDirectives = useFleetStore((s) => s.customDirectives);
  const shuttingDown = useFleetStore((s) => s.shuttingDown);
  const markShuttingDown = useFleetStore((s) => s.markShuttingDown);
  const [killLoading, setKillLoading] = useState(false);
  const [killSent, setKillSent] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DrawerTab>(initialTab ?? "timeline");

  // Re-apply the caller-supplied initial tab whenever the drawer is
  // re-opened on a different session, or the caller switches the
  // requested tab. Without this, switching from Timeline -> Prompts
  // via the Investigate camera icon would only work the first time
  // -- subsequent opens would land on whatever tab the user last
  // selected manually.
  useEffect(() => {
    if (sessionId && initialTab) {
      setActiveTab(initialTab);
    }
  }, [sessionId, initialTab]);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  // Event id passed through from a Timeline "View Prompts →" click.
  // PromptsTab uses this to scroll the matching list row into view and
  // apply the highlight treatment so the user sees immediately which
  // event they just jumped from. Distinct from selectedEventId, which
  // drills into PromptViewer detail view; focus is a list-level state.
  const [focusedPromptEventId, setFocusedPromptEventId] = useState<
    string | null
  >(null);
  const [runtimeExpanded, setRuntimeExpanded] = useState(false);

  // Filter the fleet-wide custom directive list down to ones
  // registered for this session's flavor. The Directives tab button
  // and its content are gated on this being non-empty.
  const flavorDirectives = useMemo(() => {
    if (!data?.session.flavor) return [];
    return customDirectives.filter(
      (d) => d.flavor === data.session.flavor,
    );
  }, [customDirectives, data?.session.flavor]);

  // Internal detail event — set when user clicks "Open full detail" within the drawer
  const [internalDetailEvent, setInternalDetailEvent] = useState<AgentEvent | null>(null);
  // When user clicks back, dismiss the direct event detail locally
  const [directDismissed, setDirectDismissed] = useState(false);

  // Derive active detail event from props OR internal state
  const activeDetailEvent = directDismissed
    ? internalDetailEvent
    : (directEventDetail ?? internalDetailEvent);

  // Get events: prefer eventsCache (live), fall back to REST data
  const drawerEvents = useMemo(() => {
    if (sessionId) {
      const cached = eventsCache.get(sessionId);
      if (cached && cached.length > 0) return cached;
    }
    return data?.events ?? [];
  }, [sessionId, version, paginationVersion, data?.events]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reverse once, memoized — newest first
  const displayEvents = useMemo(
    () => [...drawerEvents].reverse(),
    [drawerEvents]
  );

  // Seed the has-more flag on the initial capped fetch: if the REST
  // response returned exactly ``eventsLimit`` rows, older events may
  // exist; if it returned fewer, the session history is fully loaded.
  // Running on data.events instead of drawerEvents avoids a false
  // negative on live-WS-populated sessions where the cache already
  // exceeds the server cap.
  useEffect(() => {
    if (!data) return;
    const fetched = data.events?.length ?? 0;
    setHasMoreOlder(fetched >= eventsLimit);
  }, [data, eventsLimit]);

  const handleLimitChange = useCallback(
    (next: number) => {
      if (!sessionId || next === eventsLimit) return;
      // Drop every cached layer so the next fetchSession call re-
      // issues against the new cap. Without the cache drop the
      // existing useSession entry would win and the new limit would
      // appear to do nothing.
      invalidateSessionCache(sessionId);
      setEventsLimit(next);
      setHasMoreOlder(true);
      setPaginationVersion((v) => v + 1);
    },
    [sessionId, eventsLimit],
  );

  const handleLoadOlder = useCallback(async () => {
    if (!sessionId || loadingOlder || !hasMoreOlder) return;
    const cached = eventsCache.get(sessionId) ?? [];
    if (cached.length === 0) return;
    // Cache is ASC, so index 0 is the oldest event currently visible
    // -- that's the keyset cursor for the next page.
    const oldest = cached[0];
    setLoadingOlder(true);
    try {
      const resp = await fetchOlderEvents(
        sessionId,
        oldest.occurred_at,
        eventsLimit,
      );
      const older = resp.events ?? [];
      if (older.length > 0) {
        const existing = eventsCache.get(sessionId) ?? [];
        const seen = new Set(existing.map((e) => e.id));
        const merged = [...existing];
        for (const e of older) {
          if (!seen.has(e.id)) {
            merged.push(e);
            seen.add(e.id);
          }
        }
        merged.sort(
          (a, b) =>
            new Date(a.occurred_at).getTime() -
            new Date(b.occurred_at).getTime(),
        );
        eventsCache.set(sessionId, merged);
        setPaginationVersion((v) => v + 1);
      }
      setHasMoreOlder(resp.has_more);
    } catch {
      // Leave hasMoreOlder alone so the user can retry; the button
      // re-enables itself when loadingOlder drops back to false.
    } finally {
      setLoadingOlder(false);
    }
  }, [sessionId, loadingOlder, hasMoreOlder, eventsLimit]);

  const session = data?.session;
  const isTerminal = session?.state === "closed" || session?.state === "lost";
  const isShuttingDown =
    !!session && shuttingDown.has(session.session_id);
  const hasPending =
    session?.has_pending_directive || killSent || isShuttingDown;
  // Hide the Stop Agent button for observer-only sessions (Claude Code
  // and any future hook-based plugin). Those sessions never poll for
  // directives, so the kill switch would silently no-op and mislead
  // the operator. See dashboard/src/lib/directives.ts.
  const supportsStop = !session || sessionSupportsDirectives(session);
  const showButton = session && !isTerminal && supportsStop;

  async function handleKill() {
    if (!session) return;
    setKillLoading(true);
    setKillError(null);
    try {
      await createDirective({
        action: "shutdown",
        session_id: session.session_id,
        reason: "manual_kill_switch",
        grace_period_ms: 5000,
      });
      // Mark in the fleet store so every view (not just this drawer)
      // sees the pending shutdown until the session transitions to
      // closed via a WebSocket update.
      markShuttingDown(session.session_id);
      setKillSent(true);
      setDialogOpen(false);
      setTimeout(() => setKillSent(false), 2000);
    } catch (e) {
      setKillError((e as Error).message);
    } finally {
      setKillLoading(false);
    }
  }

  function handleViewPrompts(eventId: string) {
    setActiveTab("prompts");
    setExpandedEventId(null);
    // Land directly on PromptViewer detail for the clicked Timeline
    // event, skipping the list stop. A user drilling from a specific
    // row wants that row's detail, not a list that includes it. We
    // still set focusedPromptEventId so that when the user clicks
    // "Back to event list" from detail, the origin row is
    // highlighted and scrolled into view -- preserves Fix C
    // (03792f5) on the round trip.
    setSelectedEventId(eventId);
    setFocusedPromptEventId(eventId);
  }

  const stateBadge = stateBadgeStyles[session?.state ?? "closed"] ?? stateBadgeStyles.closed;

  return (
    <AnimatePresence>
      {sessionId && (
        <motion.div
          key={sessionId}
          data-testid="session-drawer"
          className="fixed right-0 top-0 z-40 flex h-full w-[520px] flex-col"
          style={{
            background: "var(--surface)",
            borderLeft: "1px solid var(--border)",
          }}
          initial={{ x: 520 }}
          animate={{ x: 0 }}
          exit={{ x: 520 }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
        >
          {/* Header — 56px */}
          <div
            className="flex h-14 shrink-0 items-center justify-between px-4"
            style={{ borderBottom: "1px solid var(--border)" }}
          >
            <div className="flex items-center gap-3">
              {session && (
                <>
                  <span className="font-mono text-[13px]" style={{ color: "var(--text)" }}>
                    {truncateSessionId(session.session_id)}
                  </span>
                  {session.capture_enabled && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span style={{ display: "inline-flex", lineHeight: 0 }} aria-label="Prompt capture enabled">
                            <FileText size={12} strokeWidth={2.25} style={{ color: "var(--accent)" }} />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>Prompt capture enabled</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                  <span
                    className="rounded font-mono text-[10px] px-1.5 py-0.5"
                    style={{
                      background: stateBadge.bg,
                      color: stateBadge.color,
                      border: `1px solid ${stateBadge.border}`,
                      borderRadius: 3,
                    }}
                  >
                    {session.state}
                  </span>
                </>
              )}
              {!session && <span className="text-[13px]" style={{ color: "var(--text)" }}>Session</span>}
            </div>
            <div className="flex items-center gap-2">
              {showButton && (
                <>
                  {hasPending ? (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            size="sm"
                            disabled
                            data-testid="shutdown-pending-indicator"
                            aria-label="Shutdown in progress"
                            className="opacity-80 pointer-events-none animate-pulse"
                            style={{
                              background: "var(--status-lost)",
                              color: "white",
                            }}
                          >
                            Shutdown pending
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>Shutdown in progress</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                      <DialogTrigger asChild>
                        <Button size="sm" className="bg-[var(--danger)] text-white hover:bg-[var(--danger)]/90">
                          Stop Agent
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogTitle>Stop this agent?</DialogTitle>
                        <p className="text-sm text-text-muted">
                          The agent will receive the shutdown directive on its next LLM call and terminate gracefully.
                        </p>
                        <div className="flex justify-end gap-2 pt-4">
                          <DialogClose asChild>
                            <Button variant="ghost" size="sm">Cancel</Button>
                          </DialogClose>
                          <Button
                            size="sm"
                            className="bg-[var(--danger)] text-white hover:bg-[var(--danger)]/90"
                            onClick={handleKill}
                            disabled={killLoading}
                          >
                            {killLoading ? "Sending..." : "Stop Agent"}
                          </Button>
                        </div>
                      </DialogContent>
                    </Dialog>
                  )}
                </>
              )}
              {killError && (
                <span className="text-xs" style={{ color: "var(--danger)" }}>{killError}</span>
              )}
              <button
                onClick={onClose}
                className="flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-surface-hover"
              >
                <X size={16} style={{ color: "var(--text-muted)" }} />
              </button>
            </div>
          </div>

          {/* Mode 2: Event detail view */}
          {activeDetailEvent && (
            <EventDetailView
              event={activeDetailEvent}
              session={session ?? null}
              onBack={() => { setInternalDetailEvent(null); setDirectDismissed(true); onClearDirectEvent?.(); }}
            />
          )}

          {/* Loading */}
          {loading && !activeDetailEvent && displayEvents.length === 0 && (
            <div className="flex flex-1 items-center justify-center text-xs text-text-muted">
              Loading...
            </div>
          )}

          {/* Mode 1: Session view */}
          {!activeDetailEvent && displayEvents.length > 0 && data && (
            <>
              {/* Claude Code session badge — only renders for sessions
                  produced by the Claude Code plugin. Sits above the
                  metadata bar so a platform engineer opening the drawer
                  immediately sees "this is a developer Claude Code
                  session" rather than having to infer it from the
                  flavor text. Version is pulled from
                  context.frameworks["claude-code/<ver>"]; absent
                  versions collapse to just "Claude Code". */}
              {isClaudeCodeSession(data.session) && (
                <div
                  data-testid="claude-code-badge"
                  className="flex items-center gap-2 px-4 py-2"
                  style={{
                    borderBottom: "1px solid var(--border-subtle)",
                    background: "var(--accent-glow)",
                  }}
                >
                  {/* The visible "Claude Code" label sits right next
                      to the icon, so we suppress the icon's own
                      tooltip/aria-label to avoid screen readers
                      announcing the tool name twice. */}
                  <ClaudeCodeLogo size={20} title="" />
                  <span
                    className="text-[13px] font-semibold"
                    style={{ color: "var(--text)" }}
                  >
                    Claude Code
                  </span>
                  {/* Matches the CODING AGENT pill the Investigate
                      table (pages/Investigate.tsx) and Fleet sidebar
                      (components/fleet/FleetPanel.tsx) render next to
                      the flavor name. Same component, same gating via
                      isClaudeCodeSession, so the three surfaces stay
                      aligned. */}
                  <CodingAgentBadge />
                  {(() => {
                    const v = getClaudeCodeVersion(data.session);
                    return v ? (
                      <span
                        className="font-mono text-[11px]"
                        style={{ color: "var(--text-muted)" }}
                      >
                        v{v}
                      </span>
                    ) : null;
                  })()}
                </div>
              )}
              {/* Metadata bar — labelled grid. Auto-fits items into a
                  flowing two-row layout (identity on top, metrics
                  below) so the bar doesn't wrap unreadably on the
                  520px drawer. Each cell renders a small uppercase
                  label above a mono value; OS / orchestration icons
                  sit inline with the Platform field, the provider
                  logo sits inline with the Model field. */}
              <MetadataBar session={data.session} />


              {/* Runtime context panel — only renders when the session
                  has a non-empty `context` object (set once at sensor
                  init from the pluggable collector chain). Collapsed by
                  default to keep the drawer chrome compact. */}
              <RuntimePanel
                context={data.session.context}
                expanded={runtimeExpanded}
                onToggle={() => setRuntimeExpanded((v) => !v)}
              />

              {/* Tab bar -- "Directives" tab only renders when the
                  session's flavor has at least one registered
                  custom directive. Hidden entirely otherwise so
                  users aren't confronted with a dead tab. */}
              <div
                className="flex h-9 shrink-0 items-end gap-4 px-4"
                style={{ borderBottom: "1px solid var(--border)" }}
                data-testid="session-drawer-tab-bar"
              >
                {(
                  [
                    "timeline",
                    "prompts",
                    ...(flavorDirectives.length > 0 ? ["directives" as const] : []),
                  ] as DrawerTab[]
                ).map((tab) => (
                  <button
                    key={tab}
                    data-testid={`drawer-tab-${tab}`}
                    className="pb-2 text-xs font-medium capitalize transition-colors"
                    style={activeTab === tab
                      ? { color: "var(--text)", borderBottom: "2px solid var(--accent)" }
                      : { color: "var(--text-muted)" }}
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab === "timeline"
                      ? "Timeline"
                      : tab === "prompts"
                        ? "Prompts"
                        : "Directives"}
                  </button>
                ))}
              </div>

              {/* Token usage bar */}
              <div className="shrink-0 px-3 py-1.5">
                <TokenUsageBar
                  tokensUsed={data.session.tokens_used}
                  tokenLimit={data.session.token_limit}
                  warn_at_pct={data.session.warn_at_pct}
                  degrade_at_pct={data.session.degrade_at_pct}
                  block_at_pct={data.session.block_at_pct}
                />
              </div>

              {/* Tab content */}
              <div className="flex-1 overflow-y-auto">
                {activeTab === "timeline" && (
                  <EventFeed
                    events={displayEvents}
                    attachments={data?.attachments ?? []}
                    expandedEventId={expandedEventId}
                    onToggleExpand={(id) => setExpandedEventId(expandedEventId === id ? null : id)}
                    onViewPrompts={handleViewPrompts}
                    onOpenDetail={setInternalDetailEvent}
                    eventsLimit={eventsLimit}
                    onLimitChange={handleLimitChange}
                    hasMoreOlder={hasMoreOlder}
                    loadingOlder={loadingOlder}
                    onLoadOlder={handleLoadOlder}
                  />
                )}
                {activeTab === "prompts" && (
                  <PromptsTab
                    events={displayEvents}
                    selectedEventId={selectedEventId}
                    focusedEventId={focusedPromptEventId}
                    onSelectEvent={(id) => {
                      setSelectedEventId(id);
                      // Clear the focused-row treatment only when
                      // the user selects a different event from the
                      // list. When id === null (Back to event
                      // list), preserve focus so the origin row is
                      // still highlighted -- that's what makes the
                      // Timeline → detail → Back round trip land
                      // the user back on their originating row.
                      if (id !== null && id !== focusedPromptEventId) {
                        setFocusedPromptEventId(null);
                      }
                    }}
                  />
                )}
                {activeTab === "directives" && (
                  <div
                    className="p-3"
                    data-testid="directives-tab-content"
                  >
                    {flavorDirectives.map((d) => (
                      <DirectiveCard
                        key={d.id}
                        directive={d}
                        sessionId={data.session.session_id}
                      />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ---- Runtime context panel ---- */

interface RuntimePanelProps {
  context?: Record<string, unknown>;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Collapsible RUNTIME panel rendered between the metadata bar and the
 * tab bar. Hidden entirely when `context` is missing or empty -- the
 * sensor only sets context once at init() from the collector chain
 * (process / OS / orchestration / framework), and many deployments
 * will simply not have anything to show.
 */
function RuntimePanel({ context, expanded, onToggle }: RuntimePanelProps) {
  const rows = useMemo(
    () => (context ? buildRuntimeRows(context) : []),
    [context],
  );
  if (rows.length === 0) return null;

  return (
    <div
      data-testid="runtime-panel"
      style={{
        background: "var(--bg-elevated)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        data-testid="runtime-panel-toggle"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors hover:bg-surface-hover"
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-secondary)",
        }}
        aria-expanded={expanded}
      >
        <span
          style={{
            display: "inline-block",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 150ms ease",
            color: "var(--text-muted)",
          }}
        >
          ▶
        </span>
        <span>Runtime</span>
        <span
          style={{
            color: "var(--text-muted)",
            fontWeight: 400,
            textTransform: "none",
            letterSpacing: 0,
          }}
        >
          ({rows.length})
        </span>
      </button>
      {expanded && (
        <div
          data-testid="runtime-panel-grid"
          style={{
            display: "grid",
            gridTemplateColumns: "110px 1fr",
            gap: "3px 12px",
            padding: "8px 12px",
          }}
        >
          {rows.map((row) => (
            <Fragment key={row.key}>
              <div
                data-testid={`runtime-key-${row.key}`}
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                }}
              >
                {row.key}
              </div>
              <div
                data-testid={`runtime-value-${row.key}`}
                style={{
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  color: "var(--text)",
                  wordBreak: "break-all",
                }}
              >
                {row.value}
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---- Metadata bar (labelled grid) ---- */

const META_LABEL_STYLE: React.CSSProperties = {
  fontSize: 10,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 2,
  whiteSpace: "nowrap",
  fontFamily: "var(--font-ui)",
};

/**
 * Flex container for the value slot. Keeps icons and text inline on
 * one row, min-width: 0 lets the child text span shrink below its
 * intrinsic width so the ellipsis fix below actually kicks in.
 *
 * Why this is a flex container and not a plain block with
 * `text-overflow: ellipsis`: when an icon + text live together inside
 * a block with `overflow: hidden`, the browser clips the overflowing
 * content but `text-overflow` only paints an ellipsis for DIRECT
 * overflowing text. Wrapping them in `inline-flex` turned the whole
 * icon+text group into a single atomic inline box, which the parent
 * then clipped mid-glyph without any ellipsis indicator (the
 * "claude-sonnet-" bug). The fix is to make the value slot the flex
 * container, hoist the icons to be flex siblings of the text, and
 * attach the ellipsis styles to the text span directly -- now the
 * text element itself has a non-zero computed width, is marked as
 * `overflow: hidden; text-overflow: ellipsis`, and the browser can
 * compute and paint the ellipsis.
 */
const META_VALUE_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  minWidth: 0,
};

/**
 * Style for a flex-shrinkable text span inside a MetadataCell value
 * slot. Attach this to any text node that shares a cell with an icon
 * (or that needs explicit ellipsis behaviour). min-width: 0 is the
 * key piece: it overrides the flex-item default of `min-width: auto`,
 * which would otherwise keep the span at its intrinsic content width
 * and defeat the clip.
 */
const META_CLIP_STYLE: React.CSSProperties = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

interface MetadataCellProps {
  label: string;
  children: React.ReactNode;
  /** Optional native title attribute for hover tooltips. */
  title?: string;
  /** Optional testid forwarded to the cell wrapper. */
  testId?: string;
}

/**
 * One cell in the metadata grid. String children are auto-wrapped in
 * a clip-styled span; node / fragment children are rendered as-is so
 * callers can inline icons alongside text (the text node inside still
 * needs `META_CLIP_STYLE` applied explicitly).
 */
function MetadataCell({ label, children, title, testId }: MetadataCellProps) {
  // String children go through ``<TruncatedText/>`` so the cell gets
  // auto-detected ellipsis + native ``title`` hover reveal without
  // callers having to thread a ``title`` prop. Non-string children
  // keep the explicit META_CLIP_STYLE path -- they're typically
  // composite (icon + text) and the caller owns the tooltip.
  const content =
    typeof children === "string" ? (
      <TruncatedText text={children} />
    ) : (
      children
    );
  return (
    <div title={title} data-testid={testId} style={{ minWidth: 0 }}>
      <div style={META_LABEL_STYLE}>{label}</div>
      <div style={META_VALUE_STYLE}>{content}</div>
    </div>
  );
}

/**
 * Labelled metadata grid rendered between the drawer header and the
 * RUNTIME panel. Uses CSS Grid auto-fit so cells reflow into 1-3
 * columns depending on available width without wrapping mid-value.
 *
 * The Platform cell shows the OSIcon + OrchestrationIcon if either
 * has a value, plus a "Linux · x86_64 · Kubernetes" string. The Model
 * cell shows the ProviderLogo plus a date-stripped model name. Cells
 * with no data render an em-dash so the column structure stays
 * legible across sessions with mixed context coverage.
 */
function MetadataBar({ session }: { session: SessionType }) {
  const ctx = session.context as Record<string, unknown> | undefined;
  const os = ctxString(ctx, "os");
  const archStr = ctxString(ctx, "arch");
  const orchestration = ctxString(ctx, "orchestration");
  const pythonVersion = ctxString(ctx, "python_version");

  // OS cell content: "Linux · arm64" (omits arch if absent).
  const osText = [os, archStr].filter(Boolean).join(" · ");
  const osTooltip = [
    os,
    archStr,
    pythonVersion ? `Python ${pythonVersion}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // Orchestration cell content: the human label e.g. "Docker Compose".
  const orchLabel = orchestration ? getOrchestrationLabel(orchestration) : null;

  const model = session.model;

  return (
    <div
      data-testid="session-metadata-bar"
      style={{
        display: "grid",
        // minmax(140, 1fr) collapses the grid to 3 columns at the
        // 520px drawer width (inner = 496px; 3*140 + 2*16 = 452 ≤ 496,
        // 4*140 + 3*16 = 608 > 496). Each column then resolves to
        // ~155px, which is the smallest size that fits a
        // 17-char model name ("claude-sonnet-4-6") plus the provider
        // logo plus the 4px gap without triggering the ellipsis
        // clip. Anything longer than that still ellipsises cleanly.
        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        gap: "6px 16px",
        padding: "8px 12px",
        background: "var(--bg-elevated)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <MetadataCell label="Agent">{session.flavor}</MetadataCell>

      <MetadataCell label="Host" title={session.host ?? undefined}>
        {session.host ?? "—"}
      </MetadataCell>

      {session.token_name && (
        <MetadataCell
          label="Token"
          title={session.token_name}
          testId="metadata-token-name"
        >
          <span style={META_CLIP_STYLE}>{session.token_name}</span>
        </MetadataCell>
      )}

      {os && (
        <MetadataCell
          label="OS"
          title={osTooltip || undefined}
          testId="metadata-os"
        >
          <OSIcon os={os} size={12} />
          <span style={{ ...META_CLIP_STYLE, maxWidth: 120 }}>{osText}</span>
        </MetadataCell>
      )}

      {orchestration && orchLabel && (
        <MetadataCell
          label="Orchestration"
          title={orchLabel}
          testId="metadata-orchestration"
        >
          <OrchestrationIcon orchestration={orchestration} size={12} />
          <span style={{ ...META_CLIP_STYLE, maxWidth: 120 }}>
            {orchLabel}
          </span>
        </MetadataCell>
      )}

      <MetadataCell label="Started">
        {new Date(session.started_at).toLocaleTimeString()}
      </MetadataCell>

      <MetadataCell label="Duration">
        {formatDuration(session.started_at)}
      </MetadataCell>

      <MetadataCell label="Tokens">
        {session.tokens_used.toLocaleString()}
      </MetadataCell>

      <MetadataCell label="Model" title={model ?? undefined}>
        {model ? (
          <>
            <ProviderLogo provider={getProvider(model)} size={12} />
            <span style={META_CLIP_STYLE}>{truncateModel(model)}</span>
          </>
        ) : (
          "—"
        )}
      </MetadataCell>
    </div>
  );
}

/* ---- Event feed (Timeline tab) ---- */

/**
 * Zero-arg signature was previously used here; the caller in
 * SessionDrawer dropped the event id entirely, so "View Prompts →"
 * always landed on the generic list. The one-arg signature threads
 * the clicked event's id through to PromptsTab as focusedEventId.
 */
interface EventFeedProps {
  events: AgentEvent[];
  attachments: string[];
  expandedEventId: string | null;
  onToggleExpand: (id: string) => void;
  onViewPrompts: (eventId: string) => void;
  onOpenDetail?: (event: AgentEvent) => void;
  // D113 pagination controls. The pill selector renders above the
  // event map regardless of whether any events are loaded yet, so the
  // user can tune the cap from an empty state; the "Show older"
  // button renders below the list and only when more history may
  // exist.
  eventsLimit: number;
  onLimitChange: (next: number) => void;
  hasMoreOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
}

function EventFeed({
  events,
  attachments,
  expandedEventId,
  onToggleExpand,
  onViewPrompts,
  onOpenDetail,
  eventsLimit,
  onLimitChange,
  hasMoreOlder,
  loadingOlder,
  onLoadOlder,
}: EventFeedProps) {
  return (
    <div className="flex flex-col" data-testid="session-event-feed">
      <EventsLimitPills value={eventsLimit} onChange={onLimitChange} />
      {events.length === 0 ? (
        <div className="py-8 text-center text-xs text-text-muted">
          No events recorded for this session.
        </div>
      ) : (
        events.map((event) => {
        const isAttachment = isAttachmentStartEvent(event, attachments);
        const badge = isAttachment ? attachBadge : getBadge(event.event_type);
        const isExpanded = expandedEventId === event.id;
        const detail = getEventDetail(event);

        return (
          <div key={event.id}>
            {/* Row — 32px */}
            <div
              className="flex h-8 cursor-pointer items-center gap-2 px-3 transition-colors hover:bg-surface-hover"
              style={{ borderBottom: "1px solid var(--border-subtle)" }}
              onClick={() => onToggleExpand(event.id)}
              // Generic ``event-row`` testid stays for the existing
              // E2E suite. New per-type testids (Phase 4 polish)
              // pin a specific shape so T14/T15/T16 can locate
              // exactly the row they assert against — e.g.
              // ``embeddings-event-row-<id>``. Type-specific id
              // sits alongside the generic via data-event-type so
              // both selectors keep working.
              data-testid={
                event.event_type === "embeddings"
                  ? `embeddings-event-row-${event.id}`
                  : event.event_type === "llm_error"
                  ? `error-event-row-${event.id}`
                  : "event-row"
              }
              data-event-type={event.event_type}
              data-event-id={event.id}
            >
              {isAttachment ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="flex h-[18px] w-[88px] shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold uppercase"
                        style={{
                          background: `color-mix(in srgb, ${badge.cssVar} 15%, transparent)`,
                          color: badge.cssVar,
                          border: `1px solid color-mix(in srgb, ${badge.cssVar} 30%, transparent)`,
                          borderRadius: 3,
                        }}
                        data-testid="event-badge"
                      >
                        {badge.label}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      Agent re-attached with the same session ID
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : (
                <span
                  className="flex h-[18px] w-[88px] shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold uppercase"
                  style={{
                    background: `color-mix(in srgb, ${badge.cssVar} 15%, transparent)`,
                    color: badge.cssVar,
                    border: `1px solid color-mix(in srgb, ${badge.cssVar} 30%, transparent)`,
                    borderRadius: 3,
                  }}
                  data-testid="event-badge"
                >
                  {badge.label}
                </span>
              )}
              <span
                // Mixed inline content (provider logo + detail text).
                // Native ``title`` surfaces the text on hover.
                className="flex-1 truncate text-[13px] flex items-center gap-1"
                style={{ color: "var(--text)" }}
                title={detail}
              >
                {(event.event_type === "post_call" || event.event_type === "pre_call") && event.model && (
                  <ProviderLogo provider={getProvider(event.model)} size={12} />
                )}
                {detail}
                <StreamingPill event={event} />
              </span>
              <span className="w-[72px] shrink-0 text-right font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
                {new Date(event.occurred_at).toLocaleTimeString()}
              </span>
            </div>

            {/* Expanded content — no transition, just show/hide */}
            {isExpanded && (
              <ExpandedEvent
                event={event}
                onViewPrompts={
                  event.has_content ? () => onViewPrompts(event.id) : undefined
                }
                onOpenDetail={onOpenDetail ? () => onOpenDetail(event) : undefined}
              />
            )}
          </div>
        );
      })
      )}
      {events.length > 0 && hasMoreOlder && (
        <button
          type="button"
          data-testid="show-older-events"
          disabled={loadingOlder}
          onClick={onLoadOlder}
          className="flex h-9 items-center justify-center text-xs transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
          style={{
            color: "var(--accent)",
            borderTop: "1px solid var(--border-subtle)",
          }}
        >
          {loadingOlder ? "Loading…" : "Show older events"}
        </button>
      )}
    </div>
  );
}

/* ---- Streaming pill (Phase 4 polish) ---- */

/**
 * Inline ``STREAM`` pill rendered alongside the row's detail text
 * for any post_call event whose payload carries the streaming
 * sub-object. Two visual variants:
 *
 *  - completed: muted lavender pill labelled ``STREAM``. Title
 *    attribute carries chunks/p50/p95/max_gap so a hover reveals
 *    the per-chunk latency summary without expanding the row.
 *  - aborted: red pill labelled ``ABORTED``. Title appends the
 *    sensor's ``abort_reason`` so the operator sees why the
 *    stream gave up. Carries a separate ``stream-aborted-<id>``
 *    testid so T15 can branch its assertion path on outcome.
 *
 * Renders nothing when ``payload.streaming`` is absent (the row's
 * existing layout is unchanged for non-streaming post_calls).
 */
function StreamingPill({ event }: { event: AgentEvent }) {
  const stream = event.payload?.streaming;
  if (!stream) return null;
  const aborted = stream.final_outcome === "aborted";
  const ic = stream.inter_chunk_ms;
  const titleParts: string[] = [`chunks=${stream.chunk_count}`];
  if (ic) {
    titleParts.push(`p50=${ic.p50}ms`);
    titleParts.push(`p95=${ic.p95}ms`);
    titleParts.push(`max_gap=${ic.max}ms`);
  }
  if (aborted && stream.abort_reason) {
    titleParts.push(`abort_reason=${stream.abort_reason}`);
  }
  const title = titleParts.join(" · ");
  const colorVar = aborted ? "var(--event-error)" : "var(--event-llm)";
  const label = aborted ? "ABORTED" : "STREAM";
  return (
    <span
      data-testid={
        aborted ? `stream-aborted-${event.id}` : `stream-badge-${event.id}`
      }
      title={title}
      className="ml-1 inline-flex h-[16px] shrink-0 items-center rounded font-mono text-[9px] font-semibold uppercase"
      style={{
        padding: "0 5px",
        background: `color-mix(in srgb, ${colorVar} 15%, transparent)`,
        color: colorVar,
        border: `1px solid color-mix(in srgb, ${colorVar} 30%, transparent)`,
        borderRadius: 3,
        letterSpacing: "0.04em",
      }}
    >
      {label}
    </span>
  );
}

/* ---- Events-limit pill selector (D113) ---- */

/**
 * Flat two-button pill selector shown at the top of the Timeline tab
 * event feed. Mirrors the Fleet time-range pill styling
 * (Fleet.tsx:492-515) so the drawer picks up the same visual
 * vocabulary rather than inventing a new control.
 */
function EventsLimitPills({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}) {
  return (
    <div
      data-testid="events-limit-pills"
      className="flex h-9 shrink-0 items-center gap-2 px-3"
      style={{
        borderBottom: "1px solid var(--border-subtle)",
        background: "var(--bg-elevated)",
      }}
    >
      <span
        className="uppercase"
        style={{
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.06em",
          color: "var(--text-muted)",
        }}
      >
        Events
      </span>
      <div className="flex gap-0.5">
        {EVENTS_LIMIT_OPTIONS.map((opt) => (
          <button
            key={opt}
            type="button"
            data-testid={`events-limit-pill-${opt}`}
            onClick={() => onChange(opt)}
            className="rounded px-2.5 py-[3px] text-xs transition-colors"
            style={
              value === opt
                ? {
                    background: "var(--bg)",
                    color: "var(--text)",
                    border: "1px solid var(--border-strong)",
                  }
                : {
                    background: "transparent",
                    color: "var(--text-muted)",
                    border: "1px solid transparent",
                  }
            }
            aria-pressed={value === opt}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---- Expanded event detail ---- */

function ExpandedEvent({
  event,
  onViewPrompts,
  onOpenDetail,
}: {
  event: AgentEvent;
  onViewPrompts?: () => void;
  onOpenDetail?: () => void;
}) {
  const summaryRows = getSummaryRows(event);
  const payload = {
    id: event.id, event_type: event.event_type, model: event.model,
    tokens_input: event.tokens_input, tokens_output: event.tokens_output,
    tokens_total: event.tokens_total, latency_ms: event.latency_ms,
    tool_name: event.tool_name, has_content: event.has_content, occurred_at: event.occurred_at,
  };

  // Phase 4 polish: when this is an llm_error event with a
  // structured payload.error, lift it out so we can pass it to
  // <ErrorEventDetails/>. Narrowing here keeps the accordion
  // component itself unaware of the directive_result string
  // overload — it accepts only the structured shape.
  const errorPayload =
    event.event_type === "llm_error" &&
    event.payload?.error &&
    typeof event.payload.error !== "string"
      ? event.payload.error
      : null;

  return (
    <div className="px-3 py-2.5" style={{ background: "var(--bg)", borderBottom: "1px solid var(--border-subtle)" }}>
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {summaryRows.map(([key, val]) => (
          <div key={key} className="contents">
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{key}</span>
            <span className="font-mono text-xs" style={{ color: "var(--text)" }}>{val}</span>
          </div>
        ))}
      </div>
      {errorPayload && (
        <ErrorEventDetails error={errorPayload} eventId={event.id} />
      )}
      <div className="my-2" style={{ borderTop: "1px solid var(--border-subtle)" }} />
      <SyntaxJson data={payload} />
      <div className="mt-2 flex items-center gap-3">
        {onViewPrompts && (
          <button className="text-xs" style={{ color: "var(--accent)" }} onClick={(e) => { e.stopPropagation(); onViewPrompts(); }}>
            View Prompts →
          </button>
        )}
        {onOpenDetail && (
          <button className="text-[11px]" style={{ color: "var(--accent)" }} onClick={(e) => { e.stopPropagation(); onOpenDetail(); }} data-testid="open-full-detail">
            Open full detail →
          </button>
        )}
      </div>
    </div>
  );
}

/* ---- Event detail view (Mode 2) ---- */

type DetailTab = "details" | "prompts";

function EventDetailView({ event, session, onBack }: { event: AgentEvent; session: SessionType | null; onBack: () => void }) {
  const [activeTab, setActiveTab] = useState<DetailTab>("details");
  const badge = getBadge(event.event_type);
  const summaryRows = getSummaryRows(event);
  const payload = {
    id: event.id, event_type: event.event_type, model: event.model,
    tokens_input: event.tokens_input, tokens_output: event.tokens_output,
    tokens_total: event.tokens_total, latency_ms: event.latency_ms,
    tool_name: event.tool_name, has_content: event.has_content, occurred_at: event.occurred_at,
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex h-8 shrink-0 items-center px-3" style={{ background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-subtle)" }}>
        <button className="text-xs" style={{ color: "var(--accent)" }} onClick={onBack} data-testid="back-to-session">← Back to session</button>
      </div>
      <div className="flex h-14 shrink-0 items-center gap-2 px-4" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="flex h-[18px] w-[88px] shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold uppercase"
          style={{ background: `color-mix(in srgb, ${badge.cssVar} 15%, transparent)`, color: badge.cssVar, border: `1px solid color-mix(in srgb, ${badge.cssVar} 30%, transparent)`, borderRadius: 3 }}>
          {badge.label}
        </span>
        <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{session?.flavor ?? event.flavor}</span>
        <span style={{ color: "var(--text-muted)" }}>·</span>
        <span className="font-mono text-xs" style={{ color: "var(--text-muted)" }}>{truncateSessionId(session?.session_id ?? event.session_id)}</span>
      </div>
      <div className="flex h-9 shrink-0 items-end gap-4 px-4" style={{ borderBottom: "1px solid var(--border)" }}>
        {(["details", "prompts"] as const).map((tab) => (
          <button key={tab} className="pb-2 text-xs font-medium capitalize transition-colors"
            style={activeTab === tab ? { color: "var(--text)", borderBottom: "2px solid var(--accent)" } : { color: "var(--text-muted)" }}
            onClick={() => setActiveTab(tab)}>
            {tab === "details" ? "Details" : "Prompts"}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {activeTab === "details" && (
          <div className="p-3" style={{ background: "var(--bg)" }}>
            <div className="mb-3 grid gap-x-3 gap-y-1" style={{ gridTemplateColumns: "140px 1fr" }}>
              {summaryRows.map(([key, val]) => (
                <div key={key} className="contents">
                  <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{key}</span>
                  <span className="font-mono text-xs" style={{ color: "var(--text)" }}>{val}</span>
                </div>
              ))}
            </div>
            <div className="mb-3" style={{ borderTop: "1px solid var(--border-subtle)" }} />
            <SyntaxJson data={payload} />
          </div>
        )}
        {activeTab === "prompts" && (
          event.has_content
            ? <PromptViewer eventId={event.id} />
            : <div className="px-4 py-6 text-[13px]" style={{ color: "var(--text-muted)" }}>Prompt capture is not enabled for this deployment.</div>
        )}
      </div>
    </div>
  );
}

/* ---- Prompts tab ---- */

interface PromptsTabProps {
  events: AgentEvent[];
  selectedEventId: string | null;
  /**
   * Event id the user came from via a Timeline "View Prompts →"
   * click. When set (and no selectedEventId drilling into detail),
   * the matching list row scrolls into view and renders with the
   * accent-glow highlight so the user sees the origin event
   * immediately. Distinct from selectedEventId, which replaces the
   * list with PromptViewer.
   */
  focusedEventId: string | null;
  onSelectEvent: (id: string | null) => void;
}

function PromptsTab({
  events,
  selectedEventId,
  focusedEventId,
  onSelectEvent,
}: PromptsTabProps) {
  // post_call carries prompt+response for an LLM turn; tool_call now
  // also carries content when the plugin has captureToolInputs on
  // (tools[] = sanitised tool input, response[] = tool_result when
  // capturePrompts is also on). Both belong in the Prompts tab.
  const contentEvents = events.filter(
    (e) =>
      e.has_content &&
      (e.event_type === "post_call" || e.event_type === "tool_call"),
  );
  const rowRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Scroll the focused row into view once the list is mounted. block:
  // "center" keeps the row visually centred, not flush with the top
  // where it can be clipped by the tab bar. Runs only when the
  // focused id changes -- re-rendering the same focus after state
  // churn shouldn't re-scroll the user mid-scroll.
  useEffect(() => {
    if (!focusedEventId || selectedEventId) return;
    const node = rowRefs.current[focusedEventId];
    if (node) {
      node.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusedEventId, selectedEventId]);

  if (contentEvents.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-xs text-text-muted">
        Prompt capture is not enabled for this deployment.
      </div>
    );
  }

  if (selectedEventId) {
    return (
      <div className="flex flex-col">
        <div className="px-3 py-2" style={{ borderBottom: "1px solid var(--border)" }}>
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => onSelectEvent(null)}>← Back to event list</Button>
        </div>
        <PromptViewer eventId={selectedEventId} />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {contentEvents.map((event) => {
        const badge = getBadge(event.event_type);
        const isFocused = event.id === focusedEventId;
        return (
          <button
            key={event.id}
            ref={(el) => {
              rowRefs.current[event.id] = el;
            }}
            data-testid={`prompts-row-${event.id}`}
            data-focused={isFocused ? "true" : undefined}
            className="flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-surface-hover"
            style={{
              borderBottom: "1px solid var(--border-subtle)",
              // Same accent-glow + accent-left treatment the fleet
              // sidebar uses for its active flavor row, so the
              // highlight reads as "selected / focused" and reuses
              // existing visual language.
              background: isFocused ? "var(--accent-glow)" : undefined,
              borderLeft: isFocused
                ? "2px solid var(--accent)"
                : "2px solid transparent",
            }}
            onClick={() => onSelectEvent(event.id)}
          >
            <span className="flex h-[18px] w-[88px] shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold uppercase"
              style={{ background: `color-mix(in srgb, ${badge.cssVar} 15%, transparent)`, color: badge.cssVar, border: `1px solid color-mix(in srgb, ${badge.cssVar} 30%, transparent)`, borderRadius: 3 }}>
              {badge.label}
            </span>
            <span className="font-mono" style={{ color: "var(--text-muted)" }}>{new Date(event.occurred_at).toLocaleTimeString()}</span>
            <span style={{ color: "var(--text)" }}>{event.model}</span>
          </button>
        );
      })}
    </div>
  );
}

