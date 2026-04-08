import { motion } from "framer-motion";
import type { EventType } from "@/lib/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Map event types to CSS variable names and icon characters. */
const eventTypeConfig: Record<
  EventType,
  { cssVar: string; icon: string; label: string }
> = {
  pre_call: { cssVar: "var(--event-llm)", icon: "\u25B6", label: "LLM Call" },
  post_call: { cssVar: "var(--event-llm)", icon: "\u25C0", label: "LLM Response" },
  tool_call: { cssVar: "var(--event-tool)", icon: "\u2699", label: "Tool Call" },
  policy_warn: { cssVar: "var(--event-warn)", icon: "\u26A0", label: "Policy Warn" },
  policy_block: { cssVar: "var(--event-block)", icon: "\u2717", label: "Policy Block" },
  policy_degrade: { cssVar: "var(--event-degrade)", icon: "\u25BC", label: "Policy Degrade" },
  session_start: { cssVar: "var(--event-lifecycle)", icon: "\u25CF", label: "Session Start" },
  session_end: { cssVar: "var(--event-lifecycle)", icon: "\u25CB", label: "Session End" },
  heartbeat: { cssVar: "var(--event-lifecycle)", icon: "\u2665", label: "Heartbeat" },
};

/** Fallback for unknown event types. */
const defaultConfig = { cssVar: "var(--event-lifecycle)", icon: "\u00B7", label: "Event" };

export interface EventNodeProps {
  x: number;
  eventType: EventType;
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

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.div
          className="absolute top-1/2 -translate-y-1/2 cursor-pointer rounded-full flex items-center justify-center"
          style={{
            left: x,
            width: 10,
            height: 10,
            backgroundColor: color,
          }}
          initial={{ scale: 0, opacity: 0 }}
          animate={{
            scale: 1,
            opacity: 1,
            boxShadow: `0 0 4px ${color}`,
          }}
          transition={{ duration: 0.3 }}
          whileHover={{
            scale: 1.6,
            boxShadow: `0 0 12px ${color}`,
          }}
          onClick={onClick}
        >
          <span
            className="text-[5px] leading-none text-white select-none pointer-events-none"
            aria-hidden="true"
          >
            {config.icon}
          </span>
        </motion.div>
      </TooltipTrigger>
      <TooltipContent>
        <p className="font-mono text-xs font-semibold">
          {config.label}
        </p>
        <p className="text-xs text-text-muted">
          {flavor} / {sessionId.slice(0, 8)}
        </p>
        {model && (
          <p className="text-xs text-text-muted">{model}</p>
        )}
        {toolName && (
          <p className="text-xs text-text-muted">Tool: {toolName}</p>
        )}
        {tokensTotal != null && (
          <p className="text-xs text-text-muted">{tokensTotal.toLocaleString()} tokens</p>
        )}
        {latencyMs != null && (
          <p className="text-xs text-text-muted">{latencyMs}ms</p>
        )}
        <p className="text-[10px] text-text-muted">
          {new Date(occurredAt).toLocaleTimeString()}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
