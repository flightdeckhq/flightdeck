import type { FlavorSummary } from "@/lib/types";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { SessionStateBar } from "./SessionStateBar";
import { PolicyEventList } from "./PolicyEventList";

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
          <CardTitle>Policy Events</CardTitle>
        </CardHeader>
        <CardContent>
          <PolicyEventList />
        </CardContent>
      </Card>
    </div>
  );
}
