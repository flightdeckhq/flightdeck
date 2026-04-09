import { useRef, useEffect, useState, memo } from "react";
import type { EventType } from "@/lib/types";
import { truncateSessionId } from "@/lib/events";
import {
  Zap,
  Wrench,
  AlertTriangle,
  XCircle,
  ArrowDown,
  Play,
  Square,
  Check,
  Circle,
} from "lucide-react";

/** Map event types to CSS variable names and labels. */
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
  x,
  eventType,
  sessionId,
  flavor,
  model,
  toolName,
  tokensTotal,
  latencyMs,
  occurredAt,
  eventId,
  onClick,
  size = 24,
  isVisible = true,
}: EventNodeProps) {
  const config = eventTypeConfig[eventType] ?? defaultConfig;
  const color = config.cssVar;
  const nodeRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState(false);
  const iconSize = size <= 20 ? 11 : 13;

  // Fade-in animation on mount
  useEffect(() => {
    const el = nodeRef.current;
    if (!el) return;
    el.style.opacity = "0";
    requestAnimationFrame(() => {
      el.style.transition = "opacity 300ms ease, transform 150ms ease";
      el.style.opacity = "1";
    });
  }, []);

  const IconComponent = config.Icon;

  return (
    <div
      ref={nodeRef}
      className="absolute top-1/2 -translate-y-1/2 cursor-pointer rounded-full flex items-center justify-center flex-shrink-0"
      style={{
        left: x,
        width: size,
        height: size,
        backgroundColor: color,
        color: "white",
        border: "1.5px solid rgba(255,255,255,0.1)",
        transform: hovered
          ? "translateY(-50%) scale(1.25)"
          : "translateY(-50%) scale(1)",
        transition: "transform 150ms ease, opacity 150ms ease",
        zIndex: hovered ? 10 : 1,
        opacity: isVisible ? 1 : 0,
        pointerEvents: isVisible ? "auto" : "none",
      }}
      onClick={(e) => {
        e.stopPropagation();
        onClick(eventId);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <IconComponent size={iconSize} />

      {hovered && (
        <div
          className="absolute z-50 whitespace-nowrap rounded"
          style={{
            bottom: "calc(100% + 8px)",
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            padding: "6px 8px",
            fontSize: 11,
            pointerEvents: "none",
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
        </div>
      )}
    </div>
  );
}

export const EventNode = memo(EventNodeComponent, (prev, next) => {
  if (prev.x !== next.x) return false;
  if (prev.isVisible !== next.isVisible) return false;
  if (prev.eventId !== next.eventId) return false;
  if (prev.size !== next.size) return false;
  return true;
});
