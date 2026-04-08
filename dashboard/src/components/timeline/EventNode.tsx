import { useRef, useEffect } from "react";
import type { EventType } from "@/lib/types";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Map event types to CSS variable names, icons, and labels. */
const eventTypeConfig: Record<
  string,
  { cssVar: string; icon: React.ReactNode; label: string }
> = {
  pre_call: { cssVar: "var(--event-llm)", icon: <Zap size={10} />, label: "LLM Call" },
  post_call: { cssVar: "var(--event-llm)", icon: <Zap size={10} />, label: "LLM Response" },
  tool_call: { cssVar: "var(--event-tool)", icon: <Wrench size={10} />, label: "Tool Call" },
  policy_warn: { cssVar: "var(--event-warn)", icon: <AlertTriangle size={10} />, label: "Policy Warn" },
  policy_block: { cssVar: "var(--event-block)", icon: <XCircle size={10} />, label: "Policy Block" },
  policy_degrade: { cssVar: "var(--event-degrade)", icon: <ArrowDown size={10} />, label: "Policy Degrade" },
  session_start: { cssVar: "var(--event-lifecycle)", icon: <Play size={10} />, label: "Session Start" },
  session_end: { cssVar: "var(--event-lifecycle)", icon: <Square size={10} />, label: "Session End" },
  directive_result: { cssVar: "var(--event-directive)", icon: <Check size={10} />, label: "Directive Result" },
  heartbeat: { cssVar: "var(--event-lifecycle)", icon: <Circle size={10} />, label: "Heartbeat" },
};

const defaultConfig = { cssVar: "var(--event-lifecycle)", icon: <Circle size={10} />, label: "Event" };

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
  onClick: () => void;
}

export function EventNode({
  x,
  eventType,
  sessionId,
  flavor,
  model,
  toolName,
  tokensTotal,
  latencyMs,
  occurredAt,
  onClick,
}: EventNodeProps) {
  const config = eventTypeConfig[eventType] ?? defaultConfig;
  const color = config.cssVar;
  const nodeRef = useRef<HTMLDivElement>(null);

  // Fade-in animation on mount
  useEffect(() => {
    const el = nodeRef.current;
    if (!el) return;
    el.style.opacity = "0";
    requestAnimationFrame(() => {
      el.style.transition = "opacity 300ms ease";
      el.style.opacity = "1";
    });
  }, []);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          ref={nodeRef}
          className="absolute top-1/2 -translate-y-1/2 cursor-pointer rounded-full flex items-center justify-center flex-shrink-0"
          style={{
            left: x,
            width: 18,
            height: 18,
            backgroundColor: color,
            color: "white",
          }}
          onClick={(e) => {
            e.stopPropagation();
            onClick();
          }}
        >
          {config.icon}
        </div>
      </TooltipTrigger>
      <TooltipContent>
        <p className="font-mono text-xs font-semibold">{config.label}</p>
        <p className="text-xs text-text-muted">
          {flavor} / {sessionId.slice(0, 8)}
        </p>
        {model && <p className="text-xs text-text-muted">{model}</p>}
        {toolName && <p className="text-xs text-text-muted">Tool: {toolName}</p>}
        {tokensTotal != null && (
          <p className="text-xs text-text-muted">{tokensTotal.toLocaleString()} tokens</p>
        )}
        {latencyMs != null && <p className="text-xs text-text-muted">{latencyMs}ms</p>}
        <p className="text-[10px] text-text-muted">
          {new Date(occurredAt).toLocaleTimeString()}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
