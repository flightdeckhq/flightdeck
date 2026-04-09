import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useSession } from "@/hooks/useSession";
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
import { createDirective } from "@/lib/api";
import { getBadge, getEventDetail, getSummaryRows } from "@/lib/events";
import { SyntaxJson } from "@/components/ui/syntax-json";
import type { AgentEvent } from "@/lib/types";

type DrawerTab = "timeline" | "prompts";

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

/* ---- Helper: format duration ---- */

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

/* ---- Main component ---- */

interface SessionDrawerProps {
  sessionId: string | null;
  onClose: () => void;
}

export function SessionDrawer({ sessionId, onClose }: SessionDrawerProps) {
  const { data, loading } = useSession(sessionId);
  const [killLoading, setKillLoading] = useState(false);
  const [killSent, setKillSent] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<DrawerTab>("timeline");
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const session = data?.session;
  const isTerminal = session?.state === "closed" || session?.state === "lost";
  const hasPending = session?.has_pending_directive || killSent;
  const showButton = session && !isTerminal;

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
      setKillSent(true);
      setDialogOpen(false);
      setTimeout(() => setKillSent(false), 2000);
    } catch (e) {
      setKillError((e as Error).message);
    } finally {
      setKillLoading(false);
    }
  }

  function handleViewPrompts() {
    setActiveTab("prompts");
    setExpandedEventId(null);
  }

  const stateBadge = stateBadgeStyles[session?.state ?? "closed"] ?? stateBadgeStyles.closed;

  return (
    <AnimatePresence>
      {sessionId && (
        <motion.div
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
                    {session.session_id.slice(0, 12)}
                  </span>
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
              {/* Kill switch */}
              {showButton && (
                <>
                  {hasPending ? (
                    <Button
                      size="sm"
                      disabled
                      className="opacity-60"
                      title="A shutdown directive is already in flight"
                    >
                      Shutdown pending
                    </Button>
                  ) : (
                    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                      <DialogTrigger asChild>
                        <Button
                          size="sm"
                          className="bg-[var(--danger)] text-white hover:bg-[var(--danger)]/90"
                        >
                          Stop Agent
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogTitle>Stop this agent?</DialogTitle>
                        <p className="text-sm text-text-muted">
                          The agent will receive the shutdown directive on its
                          next LLM call and terminate gracefully.
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

          {loading && (
            <div className="flex flex-1 items-center justify-center text-xs text-text-muted">
              Loading...
            </div>
          )}

          {data && (
            <>
              {/* Metadata bar — 32px */}
              <div
                className="flex h-8 shrink-0 items-center px-3 font-mono text-[11px]"
                style={{
                  background: "var(--bg-elevated)",
                  borderBottom: "1px solid var(--border-subtle)",
                  color: "var(--text-secondary)",
                }}
              >
                <span>{data.session.flavor}</span>
                {data.session.host && (
                  <>
                    <span className="mx-1.5" style={{ color: "var(--text-muted)" }}>·</span>
                    <span>{data.session.host}</span>
                  </>
                )}
                <span className="mx-1.5" style={{ color: "var(--text-muted)" }}>·</span>
                <span>{new Date(data.session.started_at).toLocaleTimeString()}</span>
                <span className="mx-1.5" style={{ color: "var(--text-muted)" }}>·</span>
                <span>{formatDuration(data.session.started_at)}</span>
                <span className="mx-1.5" style={{ color: "var(--text-muted)" }}>·</span>
                <span>{data.session.tokens_used.toLocaleString()} tok</span>
              </div>

              {/* Tab bar — 36px */}
              <div
                className="flex h-9 shrink-0 items-end gap-4 px-4"
                style={{ borderBottom: "1px solid var(--border)" }}
              >
                {(["timeline", "prompts"] as const).map((tab) => (
                  <button
                    key={tab}
                    className="pb-2 text-xs font-medium capitalize transition-colors"
                    style={
                      activeTab === tab
                        ? {
                            color: "var(--text)",
                            borderBottom: "2px solid var(--accent)",
                          }
                        : { color: "var(--text-muted)" }
                    }
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab === "timeline" ? "Timeline" : "Prompts"}
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
                    events={data.events}
                    expandedEventId={expandedEventId}
                    onToggleExpand={(id) =>
                      setExpandedEventId(expandedEventId === id ? null : id)
                    }
                    onViewPrompts={handleViewPrompts}
                  />
                )}
                {activeTab === "prompts" && (
                  <PromptsTab
                    events={data.events}
                    selectedEventId={selectedEventId}
                    onSelectEvent={setSelectedEventId}
                  />
                )}
              </div>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ---- Event feed (Timeline tab) ---- */

interface EventFeedProps {
  events: AgentEvent[];
  expandedEventId: string | null;
  onToggleExpand: (id: string) => void;
  onViewPrompts: () => void;
}

function EventFeed({ events, expandedEventId, onToggleExpand, onViewPrompts }: EventFeedProps) {
  if (events.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-text-muted">
        No events recorded for this session.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {events.map((event) => {
        const badge = getBadge(event.event_type);
        const isExpanded = expandedEventId === event.id;
        const detail = getEventDetail(event);

        return (
          <div key={event.id}>
            {/* Row — 32px */}
            <div
              className="flex h-8 cursor-pointer items-center gap-2 px-3 transition-colors hover:bg-surface-hover"
              style={{ borderBottom: "1px solid var(--border-subtle)" }}
              onClick={() => onToggleExpand(event.id)}
              data-testid="event-row"
            >
              {/* Type badge */}
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

              {/* Detail */}
              <span
                className="flex-1 truncate text-[13px]"
                style={{ color: "var(--text)" }}
              >
                {detail}
              </span>

              {/* Timestamp */}
              <span
                className="w-[72px] shrink-0 text-right font-mono text-[11px]"
                style={{ color: "var(--text-muted)" }}
              >
                {new Date(event.occurred_at).toLocaleTimeString()}
              </span>
            </div>

            {/* Expanded content */}
            <div
              style={{
                maxHeight: isExpanded ? 400 : 0,
                opacity: isExpanded ? 1 : 0,
                overflow: "hidden",
                transition: "max-height 300ms ease, opacity 200ms ease",
              }}
            >
              {isExpanded && (
                <ExpandedEvent
                  event={event}
                  onViewPrompts={event.has_content ? onViewPrompts : undefined}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---- Expanded event detail ---- */

function ExpandedEvent({
  event,
  onViewPrompts,
}: {
  event: AgentEvent;
  onViewPrompts?: () => void;
}) {
  const summaryRows = getSummaryRows(event);

  const payload = {
    id: event.id,
    event_type: event.event_type,
    model: event.model,
    tokens_input: event.tokens_input,
    tokens_output: event.tokens_output,
    tokens_total: event.tokens_total,
    latency_ms: event.latency_ms,
    tool_name: event.tool_name,
    has_content: event.has_content,
    occurred_at: event.occurred_at,
  };

  return (
    <div
      className="px-3 py-2.5"
      style={{
        background: "var(--bg)",
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      {/* Summary grid */}
      <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {summaryRows.map(([key, val]) => (
          <div key={key} className="contents">
            <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
              {key}
            </span>
            <span className="font-mono text-xs" style={{ color: "var(--text)" }}>
              {val}
            </span>
          </div>
        ))}
      </div>

      {/* Divider */}
      <div className="my-2" style={{ borderTop: "1px solid var(--border-subtle)" }} />

      {/* JSON payload */}
      <SyntaxJson data={payload} />

      {/* View Prompts link */}
      {onViewPrompts && (
        <button
          className="mt-2 text-xs"
          style={{ color: "var(--accent)" }}
          onClick={(e) => {
            e.stopPropagation();
            onViewPrompts();
          }}
        >
          View Prompts →
        </button>
      )}
    </div>
  );
}

/* ---- Prompts tab ---- */

interface PromptsTabProps {
  events: AgentEvent[];
  selectedEventId: string | null;
  onSelectEvent: (id: string | null) => void;
}

function PromptsTab({ events, selectedEventId, onSelectEvent }: PromptsTabProps) {
  const contentEvents = events.filter(
    (e) => e.has_content && e.event_type === "post_call"
  );

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
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => onSelectEvent(null)}
          >
            ← Back to event list
          </Button>
        </div>
        <PromptViewer eventId={selectedEventId} />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {contentEvents.map((event) => {
        const badge = getBadge(event.event_type);
        return (
          <button
            key={event.id}
            className="flex items-center gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-surface-hover"
            style={{ borderBottom: "1px solid var(--border-subtle)" }}
            onClick={() => onSelectEvent(event.id)}
          >
            <span
              className="flex h-[18px] w-[88px] shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold uppercase"
              style={{
                background: `color-mix(in srgb, ${badge.cssVar} 15%, transparent)`,
                color: badge.cssVar,
                border: `1px solid color-mix(in srgb, ${badge.cssVar} 30%, transparent)`,
                borderRadius: 3,
              }}
            >
              {badge.label}
            </span>
            <span className="font-mono" style={{ color: "var(--text-muted)" }}>
              {new Date(event.occurred_at).toLocaleTimeString()}
            </span>
            <span style={{ color: "var(--text)" }}>{event.model}</span>
          </button>
        );
      })}
    </div>
  );
}
