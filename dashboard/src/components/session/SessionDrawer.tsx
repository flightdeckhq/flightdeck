import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { useSession } from "@/hooks/useSession";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SessionTimeline } from "./SessionTimeline";
import { TokenUsageBar } from "./TokenUsageBar";
import type { SessionState } from "@/lib/types";

interface SessionDrawerProps {
  sessionId: string | null;
  onClose: () => void;
}

export function SessionDrawer({ sessionId, onClose }: SessionDrawerProps) {
  const { data, loading } = useSession(sessionId);

  return (
    <AnimatePresence>
      {sessionId && (
        <motion.div
          className="fixed right-0 top-0 z-40 flex h-full w-[420px] flex-col border-l border-border bg-surface shadow-2xl"
          initial={{ x: 420 }}
          animate={{ x: 0 }}
          exit={{ x: 420 }}
          transition={{ type: "spring", damping: 25, stiffness: 200 }}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold">Session</h2>
              {data?.session && (
                <Badge
                  variant={data.session.state as SessionState}
                >
                  {data.session.state}
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

              {/* Event timeline */}
              <div className="flex-1 overflow-y-auto">
                <SessionTimeline events={data.events} />
              </div>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
