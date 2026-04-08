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
import { SessionTimeline } from "./SessionTimeline";
import { TokenUsageBar } from "./TokenUsageBar";
import { createDirective } from "@/lib/api";
import type { SessionState } from "@/lib/types";

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
