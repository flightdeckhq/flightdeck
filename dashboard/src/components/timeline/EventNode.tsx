import { useEffect, useState, memo, useCallback } from "react";
import { createPortal } from "react-dom";
import type { EventType } from "@/lib/types";
import { truncateSessionId } from "@/lib/events";
import {
  Zap, Wrench, AlertTriangle, XCircle, ArrowDown,
  Play, Square, Check, Circle,
} from "lucide-react";

const eventTypeConfig: Record<
  string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { cssVar: string; label: string; Icon: React.ComponentType<any> }
> = {
  pre_call: { cssVar: "var(--event-llm)", Icon: Zap, label: "LLM Call" },
  post_call: { cssVar: "var(--event-llm)", Icon: Zap, label: "LLM Response" },
  tool_call: { cssVar: "var(--event-tool)", Icon: Wrench, label: "Tool Call" },
  policy_warn: { cssVar: "var(--event-warn)", Icon: AlertTriangle, label: "Policy Warn" },
  policy_block: { cssVar: "var(--event-block)", Icon: XCircle, label: "Policy Block" },
  policy_degrade: { cssVar: "var(--event-degrade)", Icon: ArrowDown, label: "Policy Degrade" },
  session_start: { cssVar: "var(--event-lifecycle)", Icon: Play, label: "Session Start" },
  session_end: { cssVar: "var(--event-lifecycle)", Icon: Square, label: "Session End" },
  directive_result: { cssVar: "var(--event-directive)", Icon: Check, label: "Directive Result" },
  heartbeat: { cssVar: "var(--event-lifecycle)", Icon: Circle, label: "Heartbeat" },
};

const defaultConfig = { cssVar: "var(--event-lifecycle)", Icon: Circle, label: "Event" };

export interface EventNodeProps {
  x: number;
  eventType: EventType | string;
  sessionId: string;
  flavor: string;
  model?: string | null;
  toolName?: string | null;
  tokensTotal?: number | null;
  latencyMs?: number | null;
  occurredAt: string;
  eventId?: string;
  onClick: (eventId?: string) => void;
  size?: number;
  isVisible?: boolean;
}

function EventNodeComponent({
  x, eventType, sessionId, flavor, model, toolName,
  tokensTotal, latencyMs, occurredAt, eventId, onClick,
  size = 24, isVisible = true,
}: EventNodeProps) {
  const config = eventTypeConfig[eventType] ?? defaultConfig;
  const color = config.cssVar;
  const [hovered, setHovered] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);
  const iconSize = size <= 20 ? 11 : 13;

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleMouseEnter = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltipPos({ top: rect.top - 8, left: rect.left + rect.width / 2 });
    setHovered(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHovered(false);
    setTooltipPos(null);
  }, []);

  const IconComponent = config.Icon;
  const finalOpacity = isVisible && mounted ? 1 : 0;

  return (
    <>
      <div
        className="absolute top-1/2 -translate-y-1/2 cursor-pointer rounded-full flex items-center justify-center flex-shrink-0"
        style={{
          left: x, width: size, height: size,
          backgroundColor: color, color: "white",
          border: "1.5px solid rgba(255,255,255,0.1)",
          transform: hovered ? "translateY(-50%) scale(1.25)" : "translateY(-50%) scale(1)",
          transition: "transform 150ms ease, opacity 300ms ease",
          zIndex: hovered ? 10 : 1,
          opacity: finalOpacity,
          pointerEvents: isVisible ? "auto" : "none",
        }}
        onClick={(e) => { e.stopPropagation(); onClick(eventId); }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <IconComponent size={iconSize} />
      </div>

      {/* Tooltip rendered in a portal to escape overflow:hidden */}
      {hovered && tooltipPos && createPortal(
        <div
          style={{
            position: "fixed",
            top: tooltipPos.top,
            left: tooltipPos.left,
            transform: "translate(-50%, -100%)",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "6px 8px",
            fontSize: 11,
            pointerEvents: "none",
            zIndex: 9999,
            whiteSpace: "nowrap",
          }}
        >
          <div style={{ color: "var(--text-secondary)" }}>{config.label}</div>
          <div className="font-mono" style={{ color: "var(--text-muted)" }}>
            {flavor} / {truncateSessionId(sessionId)}
          </div>
          {model && <div style={{ color: "var(--text)" }}>{model}</div>}
          {toolName && <div style={{ color: "var(--text)" }}>Tool: {toolName}</div>}
          {tokensTotal != null && (
            <div style={{ color: "var(--text)" }}>{tokensTotal.toLocaleString()} tokens</div>
          )}
          {latencyMs != null && (
            <div style={{ color: "var(--text-muted)" }}>{latencyMs}ms</div>
          )}
          <div className="font-mono" style={{ color: "var(--text-muted)" }}>
            {new Date(occurredAt).toLocaleTimeString()}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

export const EventNode = memo(EventNodeComponent, (prev, next) => {
  if (prev.x !== next.x) return false;
  if (prev.isVisible !== next.isVisible) return false;
  if (prev.eventId !== next.eventId) return false;
  if (prev.size !== next.size) return false;
  return true;
});
