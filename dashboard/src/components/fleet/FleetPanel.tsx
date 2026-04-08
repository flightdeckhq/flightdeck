import { useState } from "react";
import type { FlavorSummary } from "@/lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { SessionStateBar } from "./SessionStateBar";
import { PolicyEventList } from "./PolicyEventList";
import { createDirective } from "@/lib/api";

interface FleetPanelProps {
  flavors: FlavorSummary[];
}

export function FleetPanel({ flavors }: FleetPanelProps) {
  const totalSessions = flavors.reduce((s, f) => s + f.session_count, 0);
  const totalActive = flavors.reduce((s, f) => s + f.active_count, 0);
  const totalTokens = flavors.reduce((s, f) => s + f.tokens_used_total, 0);

  return (
    <div className="flex w-64 shrink-0 flex-col gap-3 border-r border-border p-3">
      <Card>
        <CardHeader>
          <CardTitle>Fleet Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-text-muted">Flavors</span>
              <span>{flavors.length}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Sessions</span>
              <span>{totalSessions}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Active</span>
              <span className="text-success">{totalActive}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-muted">Tokens</span>
              <span>{totalTokens.toLocaleString()}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Session States</CardTitle>
        </CardHeader>
        <CardContent>
          <SessionStateBar flavors={flavors} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Flavors</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {flavors.map((f) => (
              <FlavorRow key={f.flavor} flavor={f} />
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Policy Events</CardTitle>
        </CardHeader>
        <CardContent>
          <PolicyEventList />
        </CardContent>
      </Card>
    </div>
  );
}

function FlavorRow({ flavor }: { flavor: FlavorSummary }) {
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const hasActive = flavor.active_count > 0;

  async function handleStopAll() {
    setLoading(true);
    setError(null);
    try {
      await createDirective({
        action: "shutdown_flavor",
        flavor: flavor.flavor,
        reason: "manual_fleet_kill",
        grace_period_ms: 5000,
      });
      setSent(true);
      setDialogOpen(false);
      setTimeout(() => setSent(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center justify-between text-xs">
      <div>
        <span className="font-mono">{flavor.flavor}</span>
        <span className="ml-1 text-text-muted">({flavor.active_count})</span>
      </div>
      {hasActive && !sent && (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button
              size="sm"
              className="h-5 bg-[var(--danger)] px-1.5 text-[10px] text-white hover:bg-[var(--danger)]/90"
            >
              Stop All
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogTitle>
              Stop all sessions of {flavor.flavor}?
            </DialogTitle>
            <p className="text-sm text-text-muted">
              All {flavor.active_count} active agents of this type will receive
              a shutdown directive on their next LLM call.
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
                onClick={handleStopAll}
                disabled={loading}
              >
                {loading ? "Sending..." : "Stop All"}
              </Button>
            </div>
            {error && (
              <p className="text-xs text-[var(--danger)]">{error}</p>
            )}
          </DialogContent>
        </Dialog>
      )}
      {sent && (
        <span className="text-[10px] text-text-muted">Directives sent</span>
      )}
    </div>
  );
}
