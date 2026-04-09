import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { PromptViewer } from "@/components/session/PromptViewer";
import { SyntaxJson } from "@/components/ui/syntax-json";
import { getBadge, getSummaryRows } from "@/lib/events";
import type { AgentEvent } from "@/lib/types";

type Tab = "details" | "prompts";

interface EventDetailDrawerProps {
  event: AgentEvent | null;
  onClose: () => void;
}

export function EventDetailDrawer({ event, onClose }: EventDetailDrawerProps) {
  const [activeTab, setActiveTab] = useState<Tab>("details");

  if (!event) return null;

  const badge = getBadge(event.event_type);
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
    <AnimatePresence>
      <motion.div
        className="fixed right-0 top-0 z-50 flex h-full w-[520px] flex-col"
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
            className="flex h-[18px] w-[88px] shrink-0 items-center justify-center rounded font-mono text-[10px] font-semibold uppercase"
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
            {event.flavor}
          </span>
          <span style={{ color: "var(--text-muted)" }}>·</span>
          <span className="font-mono text-xs" style={{ color: "var(--text-muted)" }}>
            {event.session_id.slice(0, 8)}
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
          <span>{new Date(event.occurred_at).toLocaleString()}</span>
          {event.latency_ms != null && event.latency_ms > 0 && (
            <>
              <span className="mx-1.5" style={{ color: "var(--text-muted)" }}>·</span>
              <span>{event.latency_ms}ms</span>
            </>
          )}
          {event.model && (
            <>
              <span className="mx-1.5" style={{ color: "var(--text-muted)" }}>·</span>
              <span>{event.model}</span>
            </>
          )}
          {event.tokens_total != null && (
            <>
              <span className="mx-1.5" style={{ color: "var(--text-muted)" }}>·</span>
              <span>{event.tokens_total.toLocaleString()} tok</span>
            </>
          )}
        </div>

        {/* Tabs — 36px */}
        <div
          className="flex h-9 shrink-0 items-end gap-4 px-4"
          style={{ borderBottom: "1px solid var(--border)" }}
        >
          {(["details", "prompts"] as const).map((tab) => (
            <button
              key={tab}
              className="pb-2 text-xs font-medium capitalize transition-colors"
              style={
                activeTab === tab
                  ? { color: "var(--text)", borderBottom: "2px solid var(--accent)" }
                  : { color: "var(--text-muted)" }
              }
              onClick={() => setActiveTab(tab)}
            >
              {tab === "details" ? "Details" : "Prompts"}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto">
          {activeTab === "details" && (
            <div className="p-3" style={{ background: "var(--bg)" }}>
              {/* Summary grid */}
              <div
                className="mb-3 grid gap-x-3 gap-y-1"
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

              <div className="mb-3" style={{ borderTop: "1px solid var(--border-subtle)" }} />

              <SyntaxJson data={payload} />
            </div>
          )}

          {activeTab === "prompts" && (
            <>
              {event.has_content ? (
                <PromptViewer eventId={event.id} />
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
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
