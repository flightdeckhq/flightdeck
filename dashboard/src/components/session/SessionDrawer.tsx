import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { Badge } from "@/components/ui/badge";
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
import type { SessionState, AgentEvent, EventType } from "@/lib/types";

type DrawerTab = "timeline" | "prompts";

/** Map event types to CSS variable names and icon characters. */
const eventTypeStyles: Record<
  EventType,
  { cssVar: string; icon: string }
> = {
  pre_call: { cssVar: "var(--event-llm)", icon: "\u25B6" },
  post_call: { cssVar: "var(--event-llm)", icon: "\u25C0" },
  tool_call: { cssVar: "var(--event-tool)", icon: "\u2699" },
  policy_warn: { cssVar: "var(--event-warn)", icon: "\u26A0" },
  policy_block: { cssVar: "var(--event-block)", icon: "\u2717" },
  policy_degrade: { cssVar: "var(--event-degrade)", icon: "\u25BC" },
  session_start: { cssVar: "var(--event-lifecycle)", icon: "\u25CF" },
  session_end: { cssVar: "var(--event-lifecycle)", icon: "\u25CB" },
  heartbeat: { cssVar: "var(--event-lifecycle)", icon: "\u2665" },
};

const defaultStyle = { cssVar: "var(--event-lifecycle)", icon: "\u00B7" };

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
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);

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

  return (
    <AnimatePresence>
      {sessionId && (
        <motion.div
          className="fixed right-0 top-0 z-40 flex h-full w-[480px] flex-col border-l border-border bg-surface shadow-2xl"
          initial={{ x: 480 }}
          animate={{ x: 0 }}
          exit={{ x: 480 }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Session</h2>
              {session && (
                <Badge variant={session.state as SessionState}>
                  {session.state}
                </Badge>
              )}
            </div>
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>

          {loading && (
            <div className="flex flex-1 items-center justify-center text-xs text-text-muted">
              Loading...
            </div>
          )}

          {data && (
            <>
              {/* Session info */}
              <div className="space-y-2 border-b border-border px-4 py-3">
                <div className="flex justify-between text-xs">
                  <span className="text-text-muted">Flavor</span>
                  <span className="font-mono">{data.session.flavor}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-text-muted">ID</span>
                  <span className="font-mono text-text-muted">
                    {data.session.session_id.slice(0, 12)}...
                  </span>
                </div>
                {data.session.model && (
                  <div className="flex justify-between text-xs">
                    <span className="text-text-muted">Model</span>
                    <span>{data.session.model}</span>
                  </div>
                )}
                <div className="flex justify-between text-xs">
                  <span className="text-text-muted">Started</span>
                  <span>
                    {new Date(data.session.started_at).toLocaleString()}
                  </span>
                </div>
                <TokenUsageBar
                  tokensUsed={data.session.tokens_used}
                  tokenLimit={data.session.token_limit}
                />
              </div>

              {/* Kill switch */}
              {showButton && (
                <div className="border-b border-border px-4 py-3">
                  {hasPending ? (
                    <Button
                      size="sm"
                      disabled
                      className="w-full opacity-60"
                      title="A shutdown directive is already in flight"
                    >
                      Shutdown pending
                    </Button>
                  ) : (
                    <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                      <DialogTrigger asChild>
                        <Button
                          size="sm"
                          className="w-full bg-[var(--danger)] text-white hover:bg-[var(--danger)]/90"
                        >
                          Stop Agent
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogTitle>Stop this agent?</DialogTitle>
                        <p className="text-sm text-text-muted">
                          The agent will receive the shutdown directive on its
                          next LLM call and terminate gracefully. Agents in
                          active loops will stop within seconds. Agents between
                          calls will stop when they next attempt an LLM call.
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
                            onClick={handleKill}
                            disabled={killLoading}
                          >
                            {killLoading ? "Sending..." : "Stop Agent"}
                          </Button>
                        </div>
                      </DialogContent>
                    </Dialog>
                  )}
                  {killError && (
                    <p className="mt-1 text-xs text-[var(--danger)]">
                      {killError}
                    </p>
                  )}
                </div>
              )}

              {/* Tab bar */}
              <div className="flex border-b border-border">
                <button
                  className={`flex-1 px-4 py-2 text-xs font-medium transition-colors ${
                    activeTab === "timeline"
                      ? "border-b-2 text-text"
                      : "text-text-muted hover:text-text"
                  }`}
                  style={
                    activeTab === "timeline"
                      ? { borderBottomColor: "var(--primary)" }
                      : undefined
                  }
                  onClick={() => setActiveTab("timeline")}
                >
                  Timeline
                </button>
                <button
                  className={`flex-1 px-4 py-2 text-xs font-medium transition-colors ${
                    activeTab === "prompts"
                      ? "border-b-2 text-text"
                      : "text-text-muted hover:text-text"
                  }`}
                  style={
                    activeTab === "prompts"
                      ? { borderBottomColor: "var(--primary)" }
                      : undefined
                  }
                  onClick={() => setActiveTab("prompts")}
                >
                  Prompts
                </button>
              </div>

              {/* Tab content */}
              <div className="flex-1 overflow-y-auto">
                {activeTab === "timeline" && (
                  <DenseEventList
                    events={data.events}
                    expandedEventId={expandedEventId}
                    onToggleExpand={(id) =>
                      setExpandedEventId(expandedEventId === id ? null : id)
                    }
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

/* ---- Dense event list for Timeline tab ---- */

interface DenseEventListProps {
  events: AgentEvent[];
  expandedEventId: string | null;
  onToggleExpand: (id: string) => void;
}

function DenseEventList({ events, expandedEventId, onToggleExpand }: DenseEventListProps) {
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
        const style = eventTypeStyles[event.event_type] ?? defaultStyle;
        const isExpanded = expandedEventId === event.id;

        return (
          <div
            key={event.id}
            className="cursor-pointer border-b border-border px-3 py-1.5 hover:bg-surface-hover transition-colors"
            onClick={() => onToggleExpand(event.id)}
          >
            <div className="flex items-center gap-2 text-xs">
              <span
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] text-white"
                style={{ backgroundColor: style.cssVar }}
              >
                {style.icon}
              </span>
              <span className="font-medium" style={{ color: style.cssVar }}>
                {event.event_type}
              </span>
              {event.model && (
                <span className="text-text-muted truncate">{event.model}</span>
              )}
              {event.tool_name && (
                <span className="font-mono text-text-muted truncate">{event.tool_name}</span>
              )}
              <span className="ml-auto shrink-0 font-mono text-[10px] text-text-muted">
                {new Date(event.occurred_at).toLocaleTimeString()}
              </span>
            </div>

            {isExpanded && (
              <div className="mt-1.5 rounded bg-bg/50 p-2 text-[10px] font-mono text-text-muted overflow-x-auto">
                <pre className="whitespace-pre-wrap break-all">
                  {JSON.stringify(
                    {
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
                    },
                    null,
                    2
                  )}
                </pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---- Prompts tab content ---- */

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
        <div className="border-b border-border px-3 py-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => onSelectEvent(null)}
          >
            &larr; Back to event list
          </Button>
        </div>
        <PromptViewer eventId={selectedEventId} />
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {contentEvents.map((event) => {
        const style = eventTypeStyles[event.event_type] ?? defaultStyle;
        return (
          <button
            key={event.id}
            className="flex items-center gap-2 border-b border-border px-3 py-2 text-left text-xs hover:bg-surface-hover"
            onClick={() => onSelectEvent(event.id)}
          >
            <span
              className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[8px] text-white"
              style={{ backgroundColor: style.cssVar }}
            >
              {style.icon}
            </span>
            <span className="font-mono text-text-muted">
              {new Date(event.occurred_at).toLocaleTimeString()}
            </span>
            <span className="font-medium">{event.event_type}</span>
            {event.model && (
              <span className="text-text-muted">{event.model}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
