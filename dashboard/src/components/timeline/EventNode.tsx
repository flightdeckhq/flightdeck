import { motion } from "framer-motion";
import type { SessionState } from "@/lib/types";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const stateColors: Record<SessionState, string> = {
  active: "var(--node-active)",
  idle: "var(--node-idle)",
  stale: "var(--node-stale)",
  closed: "var(--node-closed)",
  lost: "var(--node-lost)",
};

interface EventNodeProps {
  x: number;
  state: SessionState;
  sessionId: string;
  flavor: string;
  tokensUsed: number;
  onClick: () => void;
}

export function EventNode({
  x,
  state,
  sessionId,
  flavor,
  tokensUsed,
  onClick,
}: EventNodeProps) {
  const color = stateColors[state];
  const isActive = state === "active";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <motion.div
          className="absolute top-1/2 -translate-y-1/2 cursor-pointer rounded-full"
          style={{
            left: x,
            width: 12,
            height: 12,
            backgroundColor: color,
          }}
          initial={{ scale: 0, opacity: 0 }}
          animate={{
            scale: 1,
            opacity: 1,
            boxShadow: isActive
              ? [
                  `0 0 4px ${color}`,
                  `0 0 12px ${color}`,
                  `0 0 4px ${color}`,
                ]
              : `0 0 4px ${color}`,
          }}
          transition={
            isActive
              ? { boxShadow: { repeat: Infinity, duration: 2 } }
              : { duration: 0.3 }
          }
          whileHover={{
            scale: 1.4,
            boxShadow: `0 0 16px ${color}`,
          }}
          onClick={onClick}
        />
      </TooltipTrigger>
      <TooltipContent>
        <p className="font-mono text-xs">
          {flavor} / {sessionId.slice(0, 8)}
        </p>
        <p className="text-text-muted">
          {state} &middot; {tokensUsed.toLocaleString()} tokens
        </p>
      </TooltipContent>
    </Tooltip>
  );
}
