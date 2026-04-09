import { useState } from "react";
import type { FlavorSummary } from "@/lib/types";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogClose,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { SessionStateBar } from "./SessionStateBar";
import { PolicyEventList } from "./PolicyEventList";
import { createDirective } from "@/lib/api";
import { X } from "lucide-react";

interface FleetPanelProps {
  flavors: FlavorSummary[];
  onFlavorClick?: (flavor: string) => void;
  activeFlavorFilter?: string | null;
  children?: React.ReactNode;
}

export function FleetPanel({ flavors, onFlavorClick, activeFlavorFilter, children }: FleetPanelProps) {
  const totalSessions = flavors.reduce((s, f) => s + f.session_count, 0);
  const totalActive = flavors.reduce((s, f) => s + f.active_count, 0);
  const totalTokens = flavors.reduce((s, f) => s + f.tokens_used_total, 0);

  return (
    <div
      className="flex w-[240px] shrink-0 flex-col overflow-y-auto"
      style={{
        background: "var(--surface)",
        borderRight: "1px solid var(--border)",
      }}
    >
      {/* Fleet Overview */}
      <div className="px-3 pb-2 pt-4 text-xs font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--text-secondary)" }}>
        Fleet Overview
      </div>
      <div className="space-y-1 px-3 pb-3">
        <SidebarRow label="Flavors" value={flavors.length} />
        <SidebarRow label="Sessions" value={totalSessions} />
        <SidebarRow label="Active" value={totalActive} valueColor="var(--status-active)" />
        <SidebarRow label="Tokens" value={totalTokens.toLocaleString()} />
      </div>

      {/* Session States */}
      <div className="px-3 pb-2 pt-2 text-xs font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--text-secondary)" }}>
        Session States
      </div>
      <div className="px-3 pb-3">
        <SessionStateBar flavors={flavors} />
      </div>

      {/* Flavors */}
      <div className="px-3 pb-2 pt-2 text-xs font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--text-secondary)" }}>
        Flavors
        {activeFlavorFilter && (
          <span className="ml-1 font-normal" style={{ color: "var(--primary)" }}>
            (filtered)
          </span>
        )}
      </div>
      <div className="pb-3">
        {flavors.map((f) => (
          <FlavorItem
            key={f.flavor}
            flavor={f}
            isActive={activeFlavorFilter === f.flavor}
            onFlavorClick={onFlavorClick}
          />
        ))}
      </div>

      {/* Policy Events */}
      <div className="px-3 pb-2 pt-2 text-xs font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--text-secondary)" }}>
        Policy Events
      </div>
      <div className="px-3 pb-3">
        <PolicyEventList />
      </div>

      {children}
    </div>
  );
}

function SidebarRow({
  label,
  value,
  valueColor,
}: {
  label: string;
  value: string | number;
  valueColor?: string;
}) {
  return (
    <div className="flex items-center justify-between py-[5px] px-0 text-[13px]">
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span className="font-mono text-sm font-semibold" style={{ color: valueColor ?? "var(--text)" }}>
        {value}
      </span>
    </div>
  );
}

function FlavorItem({
  flavor,
  isActive,
  onFlavorClick,
}: {
  flavor: FlavorSummary;
  isActive?: boolean;
  onFlavorClick?: (flavor: string) => void;
}) {
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
    <div
      className="flex items-center justify-between cursor-pointer py-[5px] px-3 text-[13px] transition-colors hover:bg-surface-hover"
      style={
        isActive
          ? {
              borderLeft: "2px solid var(--accent)",
              background: "var(--accent-glow)",
              color: "var(--text)",
            }
          : { color: "var(--text)" }
      }
      onClick={() => onFlavorClick?.(flavor.flavor)}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-mono truncate">{flavor.flavor}</span>
        {flavor.agent_type === "developer" && (
          <span
            className="rounded px-1 py-0.5 text-[11px] font-semibold uppercase"
            style={{
              background: "var(--accent-glow)",
              color: "var(--primary)",
            }}
          >
            DEV
          </span>
        )}
        <span className="text-[11px] font-mono" style={{ color: "var(--text-muted)" }}>
          ({flavor.active_count})
        </span>
        {isActive && (
          <button
            className="ml-1 flex h-4 w-4 items-center justify-center rounded hover:bg-surface-hover"
            onClick={(e) => {
              e.stopPropagation();
              onFlavorClick?.(flavor.flavor);
            }}
            aria-label="Clear filter"
          >
            <X size={10} style={{ color: "var(--text-muted)" }} />
          </button>
        )}
      </div>
      {hasActive && !sent && (
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <button
              className="shrink-0 rounded px-1.5 py-0.5 text-[11px] transition-colors"
              style={{
                background: "rgba(239,68,68,0.15)",
                color: "var(--status-lost)",
                border: "1px solid rgba(239,68,68,0.3)",
              }}
              onClick={(e) => e.stopPropagation()}
            >
              Stop All
            </button>
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
              <p className="text-xs" style={{ color: "var(--danger)" }}>{error}</p>
            )}
          </DialogContent>
        </Dialog>
      )}
      {sent && (
        <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>Directives sent</span>
      )}
    </div>
  );
}
