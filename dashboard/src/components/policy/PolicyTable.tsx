import { useState } from "react";
import type { Policy } from "@/lib/types";
import { POLICY_SCOPE_LABELS, type PolicyScope } from "@/lib/policy-scope-labels";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Shield } from "lucide-react";

export interface PolicyTableProps {
  policies: Policy[];
  onEdit: (policy: Policy) => void;
  onDelete: (policy: Policy) => void;
  onCreate?: () => void;
  loading: boolean;
}

const scopeColors: Record<string, string> = {
  org: "bg-primary/20 text-primary",
  flavor: "bg-[rgba(168,85,247,0.2)] text-[#a855f7]",
  session: "bg-success/20 text-success",
};

function formatLimit(value: number | null): string {
  if (value == null) return "None";
  return value.toLocaleString();
}

function formatPct(value: number | null): string {
  if (value == null) return "\u2014";
  return `${value}%`;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function SkeletonRows() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <tr key={i}>
          {Array.from({ length: 8 }).map((_, j) => (
            <td key={j} className="px-3 py-2">
              <div className="h-4 animate-pulse rounded bg-border" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function PolicyTable({ policies, onEdit, onDelete, onCreate, loading }: PolicyTableProps) {
  const [deleteTarget, setDeleteTarget] = useState<Policy | null>(null);

  if (!loading && policies.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16">
        <Shield
          size={40}
          style={{ color: "var(--text-muted)", marginBottom: 12 }}
        />
        <p style={{ color: "var(--text)", fontSize: 15, fontWeight: 500, marginBottom: 4 }}>
          No policies configured
        </p>
        <p style={{ color: "var(--text-muted)", fontSize: 13, marginBottom: 16, textAlign: "center", maxWidth: 360 }}>
          Create a policy to start enforcing token budgets across your agent fleet.
        </p>
        {onCreate && (
          <Button onClick={onCreate}>Create Policy</Button>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th className="px-3 py-2 font-medium">Scope</th>
              <th className="px-3 py-2 font-medium">Scope value</th>
              <th className="px-3 py-2 font-medium">Token limit</th>
              <th className="px-3 py-2 font-medium">Warn</th>
              <th className="px-3 py-2 font-medium">Degrade</th>
              <th className="px-3 py-2 font-medium">Block</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <SkeletonRows />
            ) : (
              policies.map((p) => (
                <tr
                  key={p.id}
                  className="border-b border-border transition-colors hover:bg-surface-hover"
                >
                  <td className="px-3 py-2">
                    <Badge className={scopeColors[p.scope]}>
                      {POLICY_SCOPE_LABELS[p.scope as PolicyScope] ?? p.scope}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-text">
                    {p.scope_value || "\u2014"}
                  </td>
                  <td className="px-3 py-2 text-text">{formatLimit(p.token_limit)}</td>
                  <td className="px-3 py-2 text-text">{formatPct(p.warn_at_pct)}</td>
                  <td className="px-3 py-2 text-text">
                    {p.degrade_at_pct != null
                      ? `${p.degrade_at_pct}%${p.degrade_to ? ` → ${p.degrade_to}` : ""}`
                      : "\u2014"}
                  </td>
                  <td className="px-3 py-2 text-text">{formatPct(p.block_at_pct)}</td>
                  <td className="px-3 py-2 text-text-muted">{relativeTime(p.created_at)}</td>
                  <td className="flex gap-1 px-3 py-2">
                    <Button variant="ghost" size="sm" onClick={() => onEdit(p)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger hover:text-danger"
                      onClick={() => setDeleteTarget(p)}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={deleteTarget != null} onOpenChange={() => setDeleteTarget(null)}>
        <DialogContent className="max-w-sm">
          <DialogTitle>Delete this policy?</DialogTitle>
          <p className="mt-2 text-xs text-text-muted">
            This will remove the token policy for{" "}
            <span className="text-text">
              {deleteTarget?.scope === "org"
                ? "the entire organization"
                : `${deleteTarget?.scope}: ${deleteTarget?.scope_value}`}
            </span>
            . This action cannot be undone.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (deleteTarget) {
                  onDelete(deleteTarget);
                  setDeleteTarget(null);
                }
              }}
            >
              Confirm
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
