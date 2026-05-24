import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { PromptViewer } from "@/components/session/PromptViewer";
import { MCPEventDetails, isMCPEvent } from "@/components/session/MCPEventDetails";
import { SyntaxJson } from "@/components/ui/syntax-json";
import { EnrichmentSummary } from "@/components/events/EnrichmentSummary";
import { SurroundingEventsList } from "@/components/events/SurroundingEventsList";
import { fetchBulkEvents } from "@/lib/api";
import { getBadge, getSummaryRows, truncateSessionId } from "@/lib/events";
import { getProvider } from "@/lib/models";
import { ProviderLogo } from "@/components/ui/provider-logo";
import type { AgentEvent } from "@/lib/types";

type Tab = "details" | "prompts" | "neighbors";

interface EventDetailDrawerProps {
  event: AgentEvent | null;
  onClose: () => void;
  /** Optional: when provided, the drawer can replace its own event
   * via the originating-jump or surrounding-events click-swap. */
  onSwapEvent?: (event: AgentEvent) => void;
  /** Optional: when provided, the details tab renders a "View
   * entire run →" link that opens the run drawer for this event's
   * run. Omitted by mounters with no run-drawer surface. */
  onViewRun?: (sessionId: string) => void;
}

export function EventDetailDrawer({ event, onClose, onSwapEvent, onViewRun }: EventDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<Tab>("details");
  // Local override: when the drawer's host doesn't provide
  // onSwapEvent, the originating-jump and surrounding-events
  // selection still work by storing the swapped event in local
  // state and rendering that instead of the prop.
  const [swappedEvent, setSwappedEvent] = useState<AgentEvent | null>(null);

  useEffect(() => {
    // Reset the local swap when the host changes the prop event so
    // a new external selection always wins over a stale internal swap.
    setSwappedEvent(null);
  }, [event?.id]);

  const displayed = swappedEvent ?? event;
  if (!displayed) return null;

  const swapTo = (next: AgentEvent) => {
    if (onSwapEvent) onSwapEvent(next);
    else setSwappedEvent(next);
  };

  const handleJumpToOriginator = async (originatingEventId: string) => {
    // Use the same /v1/events endpoint to look up the originator —
    // session-scoped because chained events all share a session_id.
    try {
      const resp = await fetchBulkEvents({
        from: "1970-01-01T00:00:00Z",
        session_id: displayed.session_id,
        limit: 200,
      });
      const found = resp.events.find((e) => e.id === originatingEventId);
      if (found) swapTo(found);
    } catch {
      /* fail-open — drawer keeps the current event displayed */
    }
  };

  // The drawer renders against `displayed` from here on so a swap
  // updates every section without remounting the whole drawer.
  const badge = getBadge(displayed.event_type);
  const summaryRows = getSummaryRows(displayed);

  const payload = {
    id: displayed.id,
    event_type: displayed.event_type,
    model: displayed.model,
    tokens_input: displayed.tokens_input,
    tokens_output: displayed.tokens_output,
    tokens_total: displayed.tokens_total,
    latency_ms: displayed.latency_ms,
    tool_name: displayed.tool_name,
    has_content: displayed.has_content,
    occurred_at: displayed.occurred_at,
  };

  return (
    <AnimatePresence>
      <motion.div
        data-testid="event-detail-drawer"
        className="fixed right-0 top-0 z-[60] flex h-full w-[520px] flex-col"
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
          className="flex h-14 shrink-0 items-center gap-2 px-4"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          {/* Badge */}
          <span
            className="flex h-[18px] min-w-[88px] shrink-0 items-center justify-center whitespace-nowrap rounded px-2 font-mono text-[10px] font-semibold uppercase"
            style={{
              background: `color-mix(in srgb, ${badge.cssVar} 15%, transparent)`,
              color: badge.cssVar,
              border: `1px solid color-mix(in srgb, ${badge.cssVar} 30%, transparent)`,
              borderRadius: 3,
            }}
            data-testid="detail-badge"
          >
            {badge.label}
          </span>

          {/* Flavor + session ID */}
          <span className="font-mono text-xs" style={{ color: "var(--text-secondary)" }}>
            {displayed.flavor}
          </span>
          <span style={{ color: "var(--text-muted)" }}>·</span>
          <span className="font-mono text-xs" style={{ color: "var(--text-muted)" }}>
            {truncateSessionId(displayed.session_id)}
          </span>

          {/* Close */}
          <button
            className="ml-auto flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-surface-hover"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} style={{ color: "var(--text-muted)" }} />
          </button>
        </div>

        {/* Metadata bar — 32px */}
        <div
          className="flex h-8 shrink-0 items-center px-3 font-mono text-[11px]"
          style={{
            background: "var(--bg-elevated)",
            borderBottom: "1px solid var(--border-subtle)",
            color: "var(--text-secondary)",
          }}
          data-testid="detail-metadata"
        >
          <span>{new Date(displayed.occurred_at).toLocaleString()}</span>
          {displayed.latency_ms != null && displayed.latency_ms > 0 && (
            <>
              <span className="mx-1.5" style={{ color: "var(--text-muted)" }}>·</span>
              <span>{displayed.latency_ms}ms</span>
            </>
          )}
          {displayed.model && (
            <>
              <span className="mx-1.5" style={{ color: "var(--text-muted)" }}>·</span>
              <ProviderLogo provider={getProvider(displayed.model)} size={12} />
              <span className="ml-1">{displayed.model}</span>
            </>
          )}
          {displayed.tokens_total != null && (
            <>
              <span className="mx-1.5" style={{ color: "var(--text-muted)" }}>·</span>
              <span>{displayed.tokens_total.toLocaleString()} tok</span>
            </>
          )}
        </div>

        {/* Tabs — 36px */}
        <div
          className="flex h-9 shrink-0 items-end gap-4 px-4"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          {(["details", "prompts", "neighbors"] as const).map((tab) => (
            <button
              key={tab}
              className="pb-2 text-xs font-medium capitalize transition-colors"
              style={
                activeTab === tab
                  ? { color: "var(--text)", borderBottom: "2px solid var(--accent)" }
                  : { color: "var(--text-muted)" }
              }
              onClick={() => setActiveTab(tab)}
              data-testid={`detail-tab-${tab}`}
            >
              {tab}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === "details" && (
            <div className="p-3 space-y-3" style={{ background: "var(--bg)" }}>
              {/* Summary grid */}
              <div
                className="grid gap-x-3 gap-y-1"
                style={{ gridTemplateColumns: "140px 1fr" }}
              >
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

              {onViewRun && (
                <button
                  type="button"
                  data-testid="event-detail-view-run"
                  onClick={() => onViewRun(displayed.session_id)}
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 11,
                    color: "var(--accent)",
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                  }}
                >
                  View entire run →
                </button>
              )}

              <EnrichmentSummary
                event={displayed}
                onJumpToOriginator={handleJumpToOriginator}
              />

              {isMCPEvent(displayed.event_type) && (
                <MCPEventDetails event={displayed} />
              )}

              <div style={{ borderTop: "1px solid var(--border-subtle)" }} />

              <SyntaxJson data={payload} />
            </div>
          )}

          {activeTab === "prompts" && (
            <>
              {displayed.has_content ? (
                <PromptViewer eventId={displayed.id} />
              ) : (
                <div
                  className="px-4 py-6 text-[13px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  Prompt capture is not enabled for this deployment.
                </div>
              )}
            </>
          )}

          {activeTab === "neighbors" && (
            <div className="p-3" style={{ background: "var(--bg)" }}>
              <SurroundingEventsList event={displayed} onSelect={swapTo} />
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
