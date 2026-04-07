import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { AgentEvent } from "@/lib/types";

interface EventDetailProps {
  event: AgentEvent;
}

export function EventDetail({ event }: EventDetailProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="cursor-pointer border-b border-border px-3 py-2 hover:bg-surface-hover"
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center justify-between text-xs">
        <span className="font-mono text-text-muted">
          {new Date(event.occurred_at).toLocaleTimeString()}
        </span>
        <span className="font-medium">{event.event_type}</span>
        {event.model && (
          <span className="text-text-muted">{event.model}</span>
        )}
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="mt-2 space-y-1 overflow-hidden text-xs"
          >
            {event.tokens_total != null && (
              <div className="flex justify-between">
                <span className="text-text-muted">Tokens</span>
                <span>
                  {event.tokens_input?.toLocaleString()} in /{" "}
                  {event.tokens_output?.toLocaleString()} out ={" "}
                  {event.tokens_total.toLocaleString()} total
                </span>
              </div>
            )}
            {event.latency_ms != null && (
              <div className="flex justify-between">
                <span className="text-text-muted">Latency</span>
                <span>{event.latency_ms}ms</span>
              </div>
            )}
            {event.tool_name && (
              <div className="flex justify-between">
                <span className="text-text-muted">Tool</span>
                <span className="font-mono">{event.tool_name}</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
