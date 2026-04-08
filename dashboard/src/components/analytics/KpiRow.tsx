import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { fetchAnalytics, fetchFleet } from "@/lib/api";

interface KpiCardProps {
  label: string;
  value: string | number;
  changePct?: number;
  loading: boolean;
}

function KpiCard({ label, value, changePct, loading }: KpiCardProps) {
  return (
    <Card className="flex-1 min-w-[160px]">
      <CardContent className="flex flex-col gap-1">
        <span className="text-xs text-text-muted">{label}</span>
        {loading ? (
          <div className="h-7 w-20 animate-pulse rounded bg-surface-hover" />
        ) : (
          <div className="flex items-baseline gap-2">
            <span className="text-xl font-semibold text-text">
              {typeof value === "number" ? value.toLocaleString() : value}
            </span>
            {changePct !== undefined && (
              <span
                className={`text-xs font-medium ${
                  changePct >= 0 ? "text-success" : "text-danger"
                }`}
              >
                {changePct >= 0 ? "+" : ""}
                {changePct.toFixed(1)}%
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface KpiRowProps {
  range: string;
  from?: string;
  to?: string;
}

export function KpiRow({ range, from, to }: KpiRowProps) {
  const [tokens, setTokens] = useState({ value: 0, change: 0, loading: true });
  const [sessions, setSessions] = useState({ value: 0, change: 0, loading: true });
  const [policyEvents, setPolicyEvents] = useState({ value: 0, change: 0, loading: true });
  const [activeNow, setActiveNow] = useState({ value: 0, loading: true });

  useEffect(() => {
    const params = { range, from, to };

    fetchAnalytics({ ...params, metric: "tokens", group_by: "flavor" })
      .then((res) => setTokens({ value: res.totals.grand_total, change: res.totals.period_change_pct, loading: false }))
      .catch(() => setTokens((prev) => ({ ...prev, loading: false })));

    fetchAnalytics({ ...params, metric: "sessions", group_by: "flavor" })
      .then((res) => setSessions({ value: res.totals.grand_total, change: res.totals.period_change_pct, loading: false }))
      .catch(() => setSessions((prev) => ({ ...prev, loading: false })));

    fetchAnalytics({ ...params, metric: "policy_events", group_by: "flavor" })
      .then((res) => setPolicyEvents({ value: res.totals.grand_total, change: res.totals.period_change_pct, loading: false }))
      .catch(() => setPolicyEvents((prev) => ({ ...prev, loading: false })));

    fetchFleet()
      .then((res) => {
        const active = res.flavors.reduce((sum, f) => sum + f.active_count, 0);
        setActiveNow({ value: active, loading: false });
      })
      .catch(() => setActiveNow((prev) => ({ ...prev, loading: false })));
  }, [range, from, to]);

  return (
    <div className="flex gap-4 flex-wrap">
      <KpiCard label="Total Tokens" value={tokens.value} changePct={tokens.change} loading={tokens.loading} />
      <KpiCard label="Active Now" value={activeNow.value} loading={activeNow.loading} />
      <KpiCard label="Total Sessions" value={sessions.value} changePct={sessions.change} loading={sessions.loading} />
      <KpiCard label="Policy Events" value={policyEvents.value} changePct={policyEvents.change} loading={policyEvents.loading} />
    </div>
  );
}
