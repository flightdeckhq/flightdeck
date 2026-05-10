import { Fragment, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, FileText } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { TruncatedText } from "@/components/ui/TruncatedText";
import { invalidateSessionCache, useSession } from "@/hooks/useSession";
import { useFleetStore } from "@/store/fleet";
import { SHUTDOWN_GRACE_PERIOD_MS, SUCCESS_MESSAGE_DISPLAY_MS } from "@/lib/constants";
import { CLIENT_TYPE_LABEL, ClientType } from "@/lib/agent-identity";
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
import { SubAgentsTab } from "./SubAgentsTab";
import { EnrichmentSummary } from "@/components/events/EnrichmentSummary";
import { SurroundingEventsList } from "@/components/events/SurroundingEventsList";
import { EventRow } from "./EventRow";
import { createDirective, fetchBulkEvents, fetchOlderEvents, fetchSession, fetchSessions, resolveMCPPolicy } from "@/lib/api";
import {
  MCPServerDecisionText,
  type MCPServerDecision,
} from "@/components/policy/MCPServerDecisionText";
import { sessionSupportsDirectives } from "@/lib/directives";
import { ClaudeCodeLogo } from "@/components/ui/claude-code-logo";
import { CodingAgentBadge } from "@/components/ui/coding-agent-badge";
import { RelationshipPill } from "@/components/facets/RelationshipPill";
import { getClaudeCodeVersion, isClaudeCodeSession } from "@/lib/models";
import { getBadge, getSummaryRows, truncateSessionId } from "@/lib/events";
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

export type DrawerTab = "timeline" | "prompts" | "sub-agents" | "directives";

// D113 drawer pagination. Flat pill selector (mirrors Fleet's time-range
// pills at Fleet.tsx:492-515) in place of a dropdown so the control
// reads as inline chrome rather than a form field. Default 100 matches
// the Supervisor-approved initial cap; 50 gives operators a lighter
// option on very dense sessions.
export const EVENTS_LIMIT_OPTIONS = [50, 100] as const;
export const DEFAULT_EVENTS_LIMIT: (typeof EVENTS_LIMIT_OPTIONS)[number] = 100;

/* ---- State badge colors ---- */

type StateBadge = { bg: string; color: string; border: string };

// Closed-state badge serves double duty as the safe-default when an
// unrecognised state string slips in (the lookup misses and we fall
// through to this object). Declared standalone so the fallback at
// `stateBadge` doesn't return `undefined` under noUncheckedIndexedAccess.
const CLOSED_STATE_BADGE: StateBadge = {
  bg: "color-mix(in srgb, var(--status-closed) 15%, transparent)",
  color: "var(--status-closed)",
  border: "color-mix(in srgb, var(--status-closed) 30%, transparent)",
};

const stateBadgeStyles: Record<string, StateBadge> = {
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
  closed: CLOSED_STATE_BADGE,
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
  /**
   * D126: switch the drawer to a different session_id without
   * closing it. Wired by the SubAgentsTab parent / child links so
   * "open the parent" / "open the child" rebinds the drawer in
   * place. When omitted (legacy callers) the sub-agent navigation
   * falls back to closing + a parent-owned re-open path. Pages
   * that own the drawer's session-id state should pass this so the
   * inline navigation works without a flicker.
   */
  onSwitchSession?: (sessionId: string, tab?: DrawerTab) => void;
}

export function SessionDrawer({ sessionId, onClose, directEventDetail, onClearDirectEvent, version = 0, initialTab, onSwitchSession }: SessionDrawerProps) {
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

  // D140 step 6.6 A2 — re-fetch on mcp_server_attached events for
  // the open session so the MCP SERVERS panel populates live.
  // Subscribes to the fleet store's lastEvent (broadcast by every
  // WebSocket-delivered event); bumps revalidationKey when the
  // event matches our session_id + the new event type. The
  // revalidationKey threads into useSession as a useEffect dep so
  // the next render fetches fresh data from the API.
  const lastEvent = useFleetStore((s) => s.lastEvent);
  const [revalidationKey, setRevalidationKey] = useState(0);
  useEffect(() => {
    if (!sessionId || !lastEvent) return;
    if (
      lastEvent.session_id === sessionId &&
      lastEvent.event_type === "mcp_server_attached"
    ) {
      setRevalidationKey((k) => k + 1);
    }
  }, [lastEvent, sessionId]);

  const { data, loading } = useSession(sessionId, eventsLimit, revalidationKey);
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
  const [mcpServersExpanded, setMcpServersExpanded] = useState(false);

  // Filter the fleet-wide custom directive list down to ones
  // registered for this session's flavor. The Directives tab button
  // and its content are gated on this being non-empty.
  const flavorDirectives = useMemo(() => {
    if (!data?.session.flavor) return [];
    return customDirectives.filter(
      (d) => d.flavor === data.session.flavor,
    );
  }, [customDirectives, data?.session.flavor]);

  // D126 — gate the Sub-agents tab. The tab surfaces when EITHER
  // this session is a sub-agent (has parent_session_id) OR it has
  // spawned at least one child. The cheap-check here only knows
  // about the parent linkage; the children-spawned case needs a
  // server fetch (the SubAgentsSection performs it). For the tab-
  // gating step we make a simpler call: if the session is a child,
  // always show the tab; otherwise show iff the SUB-AGENTS section
  // has children. To avoid a flicker on root sessions that don't
  // yet know their child count, we eagerly fetch a children-count
  // hint. Fetch is keyed on session_id so opening + reopening a
  // session re-fires.
  // Child count is the source of truth for both gating Sub-agents tab
  // visibility AND rendering the headline "→ N" relationship pill.
  // ``r.total`` carries the unpaginated count so a single ``limit=1``
  // probe covers both jobs without a second round-trip.
  const [childCount, setChildCount] = useState<number>(0);
  useEffect(() => {
    if (!data?.session.session_id) {
      setChildCount(0);
      return;
    }
    let alive = true;
    // Cheapest possible probe: limit=1 returns at most one row plus
    // the unpaginated total. Worker keeps the partial index
    // sessions_parent_session_id_idx hot so the underlying scan is
    // ~ms.
    fetchSessions({ parent_session_id: data.session.session_id, limit: 1 })
      .then((r) => {
        if (alive) setChildCount(r.total ?? 0);
      })
      .catch(() => {
        if (alive) setChildCount(0);
      });
    return () => {
      alive = false;
    };
  }, [data?.session.session_id]);
  const hasChildren = childCount > 0;

  // Parent agent display name for the headline "↳ <parentName>" pill.
  // Only fired when the current session is a child (parent_session_id
  // is set). Falls back to the parent's flavor when agent_name is null
  // (legacy / pre-D115 sessions). Failure is silent — the pill simply
  // collapses to "(unknown parent)" rather than blocking the drawer.
  const [parentAgentLabel, setParentAgentLabel] = useState<string | null>(null);
  useEffect(() => {
    const parentId = data?.session.parent_session_id;
    if (!parentId) {
      setParentAgentLabel(null);
      return;
    }
    let alive = true;
    fetchSession(parentId, 1)
      .then((d) => {
        if (alive) {
          setParentAgentLabel(d.session?.agent_name ?? d.session?.flavor ?? null);
        }
      })
      .catch(() => {
        if (alive) setParentAgentLabel(null);
      });
    return () => {
      alive = false;
    };
  }, [data?.session.parent_session_id]);

  const showSubAgentsTab =
    !!data?.session.parent_session_id || hasChildren;

  // Internal detail event — set when user clicks "Open full detail" within the drawer
  const [internalDetailEvent, setInternalDetailEvent] = useState<AgentEvent | null>(null);
  // When user clicks back, dismiss the direct event detail locally
  const [directDismissed, setDirectDismissed] = useState(false);

  // Derive active detail event from props OR internal state
  const activeDetailEvent = directDismissed
    ? internalDetailEvent
    : (directEventDetail ?? internalDetailEvent);

  // Get events: prefer eventsCache (live), fall back to REST data.
  // ``eventsCache`` is a module-level Map read inside the memo body.
  // The memo intentionally re-runs on every ``version`` /
  // ``paginationVersion`` bump (which signal that the cache contents
  // changed) rather than on the Map reference, because the Map is
  // mutated in place — including ``eventsCache`` in deps would force
  // re-run on every render via reference identity but never on
  // actual content changes, which is backwards. The disable applies
  // to the deps line because eslint flags ``version`` /
  // ``paginationVersion`` as "unnecessary" — those bumps are exactly
  // the reactive signals the memo needs to honour.
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
    // -- that's the keyset cursor for the next page. The length>0
    // guard above means cached[0] is always defined; the explicit
    // continue keeps noUncheckedIndexedAccess happy without a
    // non-null assertion.
    const oldest = cached[0];
    if (!oldest) return;
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
        grace_period_ms: SHUTDOWN_GRACE_PERIOD_MS,
      });
      // Mark in the fleet store so every view (not just this drawer)
      // sees the pending shutdown until the session transitions to
      // closed via a WebSocket update.
      markShuttingDown(session.session_id);
      setKillSent(true);
      setDialogOpen(false);
      setTimeout(() => setKillSent(false), SUCCESS_MESSAGE_DISPLAY_MS);
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

  const stateBadge = stateBadgeStyles[session?.state ?? "closed"] ?? CLOSED_STATE_BADGE;

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

          {/* Loading. Fires until ``data`` arrives — checking only
              ``loading`` is not enough because the hook reports
              loading=false on a successful empty-events fetch (the
              session itself loaded, the Timeline is just empty). */}
          {loading && !activeDetailEvent && !data && (
            <div className="flex flex-1 items-center justify-center text-xs text-text-muted">
              Loading...
            </div>
          )}

          {/* Mode 1: Session view. Body renders whenever ``data`` is
              present — independent of how many events the session
              has. D126 sub-agent task children commonly close without
              ever making an LLM call (the Task tool returned a
              cached / non-LLM result), so ``displayEvents`` is
              legitimately empty. The original guard
              ``displayEvents.length > 0`` made the drawer body blank
              for those rows: header rendered, metadata + tabs +
              everything else didn't. The Timeline tab below carries
              its own empty-state copy so the drop-through is
              graceful even on zero events. */}
          {!activeDetailEvent && data && (
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
                    {/* S-LBL-2 centralisation: the visible label
                        comes from the shared CLIENT_TYPE_LABEL map
                        so the drawer badge can never diverge from
                        the Fleet pill / Investigate AGENT facet
                        pill / AgentTable client column. */}
                    {CLIENT_TYPE_LABEL[ClientType.ClaudeCode]}
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
                  <DrawerRelationshipPill
                    parentSessionId={data.session.parent_session_id ?? null}
                    parentAgentLabel={parentAgentLabel}
                    childCount={childCount}
                    onOpenParent={() => {
                      const pid = data.session.parent_session_id;
                      if (!pid) return;
                      if (onSwitchSession) onSwitchSession(pid);
                    }}
                    onOpenSubAgents={() => setActiveTab("sub-agents")}
                  />
                </div>
              )}
              {/* Non-Claude-Code sessions don't have the chunky
                  branding bar but still need the headline relationship
                  pill. Render a slim badge row under the same border-
                  bottom + accent-glow treatment so the visual rhythm
                  matches the Claude Code variant. The row collapses
                  entirely when the session is lone (no parent, no
                  children) so direct-SDK root sessions don't gain
                  empty chrome. */}
              {!isClaudeCodeSession(data.session) &&
                (data.session.parent_session_id || childCount > 0) && (
                  <div
                    data-testid="session-headline-relationship"
                    className="flex items-center gap-2 px-4 py-2"
                    style={{
                      borderBottom: "1px solid var(--border-subtle)",
                      background: "var(--accent-glow)",
                    }}
                  >
                    <DrawerRelationshipPill
                      parentSessionId={data.session.parent_session_id ?? null}
                      parentAgentLabel={parentAgentLabel}
                      childCount={childCount}
                      onOpenParent={() => {
                        const pid = data.session.parent_session_id;
                        if (!pid) return;
                        if (onSwitchSession) onSwitchSession(pid);
                      }}
                      onOpenSubAgents={() => setActiveTab("sub-agents")}
                    />
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

              {/* Phase 5 — MCP servers panel. Hidden when the session
                  connected to no MCP server (the array is missing or
                  empty). At-rest the row shows ``name · transport`` per
                  server; expanded reveals the full fingerprint
                  (version, protocol, capabilities, instructions). */}
              <MCPServersPanel
                context={data.session.context}
                flavor={data.session.flavor ?? null}
                expanded={mcpServersExpanded}
                onToggle={() => setMcpServersExpanded((v) => !v)}
              />

              {/* Tab bar -- "Directives" tab only renders when the
                  session's flavor has at least one registered
                  custom directive. "Sub-agents" tab only renders when
                  the session is a sub-agent (has parent_session_id)
                  or has spawned children — D126's "no placeholder
                  UI" floor (Rule 17): the tab is gated on its
                  content, not always-on. Hidden entirely otherwise
                  so users aren't confronted with a dead tab. */}
              <div
                className="flex h-9 shrink-0 items-end gap-4 px-4"
                style={{ borderBottom: "1px solid var(--border)" }}
                data-testid="session-drawer-tab-bar"
              >
                {(
                  [
                    "timeline",
                    "prompts",
                    ...(showSubAgentsTab ? ["sub-agents" as const] : []),
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
                        : tab === "sub-agents"
                          ? "Sub-agents"
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
                {activeTab === "sub-agents" && (
                  <SubAgentsTab
                    session={data.session}
                    events={drawerEvents}
                    onOpenSession={(id, tab) => {
                      // When the SubAgentsTab signals a target tab
                      // (e.g. "View N more in Timeline tab" footer
                      // click), switch tabs locally before the
                      // session rebind. The local activeTab state
                      // persists across the rebind because the host
                      // page's onSwitchSession passes initialTab=
                      // undefined, and the initialTab effect only
                      // re-applies when initialTab is truthy. Net
                      // result: drawer rebinds to the new session
                      // AND lands on the requested tab without
                      // every host page needing to thread a tab
                      // hint of its own.
                      if (tab) setActiveTab(tab);
                      if (onSwitchSession) {
                        onSwitchSession(id, tab);
                      } else {
                        // Legacy fallback: close the drawer and let
                        // the URL state pick up. Pages that wire
                        // ``onSwitchSession`` skip this branch and
                        // get an in-place rebind without flicker.
                        // Synchronous URL update — onClose() returns
                        // synchronously so React has already committed
                        // the close-drawer render by the time the
                        // location assignment fires. The previous
                        // setTimeout(0) wrapper was a banned pattern
                        // (typescript guidelines: "no setTimeout(0)
                        // to wait for the next tick") and added no
                        // value vs the synchronous form.
                        onClose();
                        window.location.search = `session=${encodeURIComponent(id)}`;
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

/* ---- Phase 5 — MCP servers panel ---- */

interface MCPServersPanelProps {
  context: Record<string, unknown> | undefined;
  /** Session flavor — used to resolve the per-server policy
   *  decision pill against the right scope. Null when the
   *  session lacks a flavor (rare; the resolve falls back to
   *  the global policy). */
  flavor: string | null;
  expanded: boolean;
  onToggle: () => void;
}

function serverDecisionKey(s: MCPServerEntry, idx: number): string {
  return `${s.name ?? `unknown-${idx}`}|${s.server_url ?? ""}`;
}

interface MCPServerEntry {
  name?: string;
  transport?: string | null;
  protocol_version?: string | number;
  version?: string | null;
  capabilities?: Record<string, unknown>;
  instructions?: string | null;
  /** D127 — server URL captured at initialize time. Empty string
   *  when the transport didn't expose a URL marker. Required for
   *  the MCP Protection Policy resolve pill (D131). */
  server_url?: string;
}

/**
 * Collapsible MCP SERVERS panel rendered below RUNTIME in the session
 * drawer. Hidden entirely when ``context.mcp_servers`` is missing or
 * empty -- only sessions that connected to at least one MCP server
 * surface this panel.
 *
 * At-rest the row shows ``name · transport`` per server. Expanded
 * reveals the full fingerprint per server: protocol version, server
 * version, capabilities (one row per non-null capability key), and
 * instructions. The fingerprint shape matches
 * ``dashboard/tests/e2e/fixtures/mcp-events.json`` exactly — that
 * fixture is the contract for this rendering.
 *
 * ``protocol_version`` is rendered as-is for both string and integer
 * shapes. The MCP SDK ships either depending on protocol version
 * negotiation; we do not coerce so a future spec change is visible
 * to operators verbatim.
 */
function MCPServersPanel({ context, flavor, expanded, onToggle }: MCPServersPanelProps) {
  const servers = useMemo<MCPServerEntry[]>(() => {
    if (!context) return [];
    const raw = (context as { mcp_servers?: unknown }).mcp_servers;
    if (!Array.isArray(raw)) return [];
    return raw.filter((s): s is MCPServerEntry => typeof s === "object" && s !== null);
  }, [context]);

  // Per-server policy decision (D131). Lazy-loaded on first
  // expand so a session that never opens the panel doesn't fire
  // resolve calls. Stored keyed by ``${name}|${url}`` so two
  // servers with the same display name but different URLs each
  // resolve independently.
  const [decisions, setDecisions] = useState<Record<string, MCPServerDecision>>(
    {},
  );

  useEffect(() => {
    if (!expanded) return;
    if (servers.length === 0) return;

    const targets = servers
      .map((s, idx) => ({
        idx,
        name: s.name ?? "",
        url: s.server_url ?? "",
        key: serverDecisionKey(s, idx),
      }))
      .filter((t) => decisions[t.key] === undefined);

    if (targets.length === 0) return;

    let cancelled = false;
    setDecisions((prev) => {
      const next = { ...prev };
      for (const t of targets) {
        next[t.key] = { kind: "loading" };
      }
      return next;
    });

    Promise.all(
      targets.map(async (t) => {
        if (!t.url || !t.name) {
          return [t.key, { kind: "missing" } as MCPServerDecision] as const;
        }
        try {
          const result = await resolveMCPPolicy({
            flavor: flavor ?? undefined,
            server_url: t.url,
            server_name: t.name,
          });
          return [t.key, { kind: "ok", result } as MCPServerDecision] as const;
        } catch (err) {
          return [
            t.key,
            {
              kind: "error",
              message:
                err instanceof Error ? err.message : "resolve failed",
            } as MCPServerDecision,
          ] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setDecisions((prev) => {
        const next = { ...prev };
        for (const [key, decision] of entries) {
          next[key] = decision;
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
    // ``decisions`` is read inside the effect body to compute
    // ``targets`` (skip already-fetched keys) but is intentionally
    // omitted from the deps array. Including it would re-fire the
    // effect every time setDecisions(loading) lands, triggering
    // cleanup → cancelled=true on the in-flight Promise.all so the
    // resolve responses never reach setDecisions(ok). Effect runs
    // only when the underlying inputs (expanded / servers / flavor)
    // change; the in-effect "skip already-fetched" filter handles
    // partial-fetch state without needing reactive deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, servers, flavor]);

  if (servers.length === 0) return null;

  return (
    <div
      data-testid="mcp-servers-panel"
      style={{
        background: "var(--bg-elevated)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        data-testid="mcp-servers-panel-toggle"
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
        <span>MCP servers</span>
        <span
          style={{
            color: "var(--text-muted)",
            fontWeight: 400,
            textTransform: "none",
            letterSpacing: 0,
          }}
        >
          ({servers.length})
        </span>
        {!expanded && (
          <span
            data-testid="mcp-servers-panel-summary"
            className="ml-2 truncate font-mono"
            style={{
              fontSize: 11,
              fontWeight: 400,
              letterSpacing: 0,
              textTransform: "none",
              color: "var(--text-muted)",
            }}
          >
            {servers
              .map((s) => formatServerSummary(s))
              .join(", ")}
          </span>
        )}
      </button>
      {expanded && (
        <div
          data-testid="mcp-servers-panel-grid"
          style={{
            padding: "8px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 12,
          }}
        >
          {servers.map((server, idx) => (
            <MCPServerRow
              key={`${server.name ?? "unknown"}-${idx}`}
              server={server}
              index={idx}
              decision={decisions[serverDecisionKey(server, idx)]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function formatServerSummary(s: MCPServerEntry): string {
  const parts: string[] = [];
  if (s.name) parts.push(s.name);
  if (s.transport) parts.push(s.transport);
  return parts.length > 0 ? parts.join(" · ") : "unknown server";
}

function MCPServerRow({
  server,
  index,
  decision,
}: {
  server: MCPServerEntry;
  index: number;
  decision: MCPServerDecision | undefined;
}) {
  const id = server.name ?? `unknown-${index}`;
  const protocol =
    server.protocol_version == null ? "—" : String(server.protocol_version);
  const capabilities = Object.entries(server.capabilities ?? {}).filter(
    ([, v]) => v != null && v !== false,
  );
  return (
    <div
      data-testid={`mcp-server-row-${id}`}
      style={{
        display: "grid",
        gridTemplateColumns: "120px 1fr",
        gap: "3px 12px",
        padding: "6px 8px",
        background: "var(--bg)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 4,
      }}
    >
      <DetailLabel>name</DetailLabel>
      <DetailValue>
        <span className="inline-flex items-center gap-2">
          {/* The testid scopes to the name span only so test
              assertions like toHaveText(server.name) match the
              name verbatim — wrapping the whole DetailValue
              concatenated the inline decision text (e.g. "no URL"
              from MCPServerDecisionText) into a single string
              that broke T25's exact-text assertion. */}
          <span data-testid={`mcp-server-name-${id}`}>
            {server.name ?? "unknown"}
          </span>
          <MCPServerDecisionText decision={decision} testId={id} />
        </span>
      </DetailValue>
      <DetailLabel>transport</DetailLabel>
      <DetailValue testId={`mcp-server-transport-${id}`}>
        {server.transport ?? "—"}
      </DetailValue>
      <DetailLabel>protocol</DetailLabel>
      <DetailValue testId={`mcp-server-protocol-${id}`}>{protocol}</DetailValue>
      {server.version != null && (
        <>
          <DetailLabel>version</DetailLabel>
          <DetailValue testId={`mcp-server-version-${id}`}>
            {server.version}
          </DetailValue>
        </>
      )}
      {capabilities.length > 0 && (
        <>
          <DetailLabel>capabilities</DetailLabel>
          <DetailValue testId={`mcp-server-capabilities-${id}`}>
            {capabilities.map(([k]) => k).join(", ")}
          </DetailValue>
        </>
      )}
      {server.instructions && (
        <>
          <DetailLabel>instructions</DetailLabel>
          <DetailValue testId={`mcp-server-instructions-${id}`}>
            {server.instructions}
          </DetailValue>
        </>
      )}
    </div>
  );
}

function DetailLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{children}</div>
  );
}

function DetailValue({
  children,
  testId,
}: {
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        fontSize: 12,
        fontFamily: "var(--font-mono)",
        color: "var(--text)",
        wordBreak: "break-all",
      }}
    >
      {children}
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
 * Headline relationship pill. Renders the same RelationshipPill the
 * Fleet swimlane + Investigate row use, so the drawer's headline
 * carries the same "↳ <parent>" / "→ <N>" affordance the user is
 * already trained on from the table surfaces.
 *
 *   * Child mode (parent_session_id set): "↳ <parent agent name>".
 *     Click rebinds the drawer to the parent session via
 *     ``onOpenParent`` (which the caller wires to onSwitchSession).
 *   * Parent mode (childCount > 0): "→ <N>". Click switches the
 *     active tab to "sub-agents" via ``onOpenSubAgents`` so the user
 *     can inspect the children inline.
 *   * Lone (no parent, no children): renders nothing.
 */
function DrawerRelationshipPill({
  parentSessionId,
  parentAgentLabel,
  childCount,
  onOpenParent,
  onOpenSubAgents,
}: {
  parentSessionId: string | null;
  parentAgentLabel: string | null;
  childCount: number;
  onOpenParent: () => void;
  onOpenSubAgents: () => void;
}) {
  if (parentSessionId) {
    return (
      <RelationshipPill
        mode="child"
        parentName={parentAgentLabel ?? undefined}
        onClick={onOpenParent}
        testId="drawer-headline-relationship-pill"
      />
    );
  }
  if (childCount > 0) {
    return (
      <RelationshipPill
        mode="parent"
        childCount={childCount}
        onClick={onOpenSubAgents}
        testId="drawer-headline-relationship-pill"
      />
    );
  }
  return null;
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
        // Per-row rendering lives in ./EventRow so the SubAgentsTab
        // inline mini-timeline can share the exact same component
        // (D126 UX revision 2026-05-04: Timeline-fidelity event
        // rendering inside the Sub-agents tab — colour-pill badges,
        // streaming pills, MCP error indicators, provider logos,
        // expand-into-ExpandedEvent on click — all match this tab
        // byte-for-byte). Don't inline-duplicate this row again;
        // shape changes belong in EventRow.tsx.
        events.map((event) => (
          <EventRow
            key={event.id}
            event={event}
            attachments={attachments}
            isExpanded={expandedEventId === event.id}
            onToggleExpand={onToggleExpand}
            onViewPrompts={onViewPrompts}
            onOpenDetail={onOpenDetail}
          />
        ))
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

// ``MCPErrorIndicator`` and ``StreamingPill`` moved to ./EventRow
// alongside the per-event row component (D126 UX revision
// 2026-05-04 — Sub-agents tab inline mini-timeline shares
// rendering with the Timeline tab).

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

// ``ExpandedEvent`` moved to ./EventRow alongside the per-event
// row component it pairs with (D126 UX revision 2026-05-04 —
// Sub-agents tab inline mini-timeline shares the exact same
// expanded-row rendering).

/* ---- Event detail view (Mode 2) ---- */

type DetailTab = "details" | "prompts" | "neighbors";

function EventDetailView({ event: initialEvent, session, onBack }: { event: AgentEvent; session: SessionType | null; onBack: () => void }) {
  const [activeTab, setActiveTab] = useState<DetailTab>("details");
  // Local swap so the originating-jump and surrounding-events click
  // can navigate within the detail view without bouncing back to the
  // session timeline.
  const [swapped, setSwapped] = useState<AgentEvent | null>(null);
  useEffect(() => { setSwapped(null); }, [initialEvent.id]);
  const event = swapped ?? initialEvent;
  const badge = getBadge(event.event_type);
  const summaryRows = getSummaryRows(event);
  const payload = {
    id: event.id, event_type: event.event_type, model: event.model,
    tokens_input: event.tokens_input, tokens_output: event.tokens_output,
    tokens_total: event.tokens_total, latency_ms: event.latency_ms,
    tool_name: event.tool_name, has_content: event.has_content, occurred_at: event.occurred_at,
  };

  const handleJumpToOriginator = async (originatingEventId: string) => {
    try {
      const resp = await fetchBulkEvents({
        from: "1970-01-01T00:00:00Z",
        session_id: event.session_id,
        limit: 200,
      });
      const found = resp.events.find((e) => e.id === originatingEventId);
      if (found) setSwapped(found);
    } catch {
      /* fail-open */
    }
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex h-8 shrink-0 items-center px-3" style={{ background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-subtle)" }}>
        <button className="text-xs" style={{ color: "var(--accent)" }} onClick={onBack} data-testid="back-to-session">← Back to session</button>
      </div>
      <div className="flex h-14 shrink-0 items-center gap-2 px-4" style={{ borderBottom: "1px solid var(--border)" }}>
        <span className="flex h-[18px] min-w-[88px] shrink-0 items-center justify-center whitespace-nowrap rounded px-2 font-mono text-[10px] font-semibold uppercase"
          style={{ background: `color-mix(in srgb, ${badge.cssVar} 15%, transparent)`, color: badge.cssVar, border: `1px solid color-mix(in srgb, ${badge.cssVar} 30%, transparent)`, borderRadius: 3 }}>
          {badge.label}
        </span>
        <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>{session?.flavor ?? event.flavor}</span>
        <span style={{ color: "var(--text-muted)" }}>·</span>
        <span className="font-mono text-xs" style={{ color: "var(--text-muted)" }}>{truncateSessionId(session?.session_id ?? event.session_id)}</span>
      </div>
      <div className="flex h-9 shrink-0 items-end gap-4 px-4" style={{ borderBottom: "1px solid var(--border)" }}>
        {(["details", "prompts", "neighbors"] as const).map((tab) => (
          <button key={tab} className="pb-2 text-xs font-medium capitalize transition-colors"
            style={activeTab === tab ? { color: "var(--text)", borderBottom: "2px solid var(--accent)" } : { color: "var(--text-muted)" }}
            onClick={() => setActiveTab(tab)}
            data-testid={`detail-tab-${tab}`}>
            {tab}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {activeTab === "details" && (
          <div className="p-3 space-y-3" style={{ background: "var(--bg)" }}>
            <div className="grid gap-x-3 gap-y-1" style={{ gridTemplateColumns: "140px 1fr" }}>
              {summaryRows.map(([key, val]) => (
                <div key={key} className="contents">
                  <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>{key}</span>
                  <span className="font-mono text-xs" style={{ color: "var(--text)" }}>{val}</span>
                </div>
              ))}
            </div>
            <EnrichmentSummary event={event} onJumpToOriginator={handleJumpToOriginator} />
            <div style={{ borderTop: "1px solid var(--border-subtle)" }} />
            <SyntaxJson data={payload} />
          </div>
        )}
        {activeTab === "prompts" && (
          event.has_content
            ? <PromptViewer eventId={event.id} />
            : <div className="px-4 py-6 text-[13px]" style={{ color: "var(--text-muted)" }}>Prompt capture is not enabled for this deployment.</div>
        )}
        {activeTab === "neighbors" && (
          <div className="p-3" style={{ background: "var(--bg)" }}>
            <SurroundingEventsList event={event} onSelect={setSwapped} />
          </div>
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
            <span className="flex h-[18px] min-w-[88px] shrink-0 items-center justify-center whitespace-nowrap rounded px-2 font-mono text-[10px] font-semibold uppercase"
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

