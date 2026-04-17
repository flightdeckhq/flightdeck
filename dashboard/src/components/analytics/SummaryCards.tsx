import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { fetchAnalytics } from "@/lib/api";
import { PROVIDER_META, type Provider } from "@/lib/models";
import { ProviderLogo } from "@/components/ui/provider-logo";

/**
 * Row 1 of the Analytics v2 page -- five summary cards (total tokens,
 * anthropic tokens, openai tokens, sessions, avg per session).
 *
 * Cards are clickable: selecting Anthropic or OpenAI promotes the
 * corresponding provider into the `filter_provider` slot that every
 * chart below reads via the page's shared AnalyticsFilters state, so
 * the whole page reflows to that provider without a separate filter
 * control. Clicking Total Tokens / Total Sessions / Avg clears the
 * provider filter (they are "show everything" cards).
 */
interface SummaryCardsProps {
  range: string;
  from?: string;
  to?: string;
  filterProvider: Provider | null;
  onSelectProvider: (provider: Provider | null) => void;
}

interface Totals {
  value: number;
  changePct: number;
}

async function total(
  params: Record<string, string | undefined>,
): Promise<Totals> {
  const res = await fetchAnalytics(params);
  return { value: res.totals.grand_total, changePct: res.totals.period_change_pct };
}

function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Math.round(n).toLocaleString();
}

interface CardSpec {
  label: string;
  value: string;
  sub: string | null;
  changePct?: number;
  /** Optional leading icon -- the Anthropic and OpenAI cards pass a
   *  <ProviderLogo> so the brand mark sits next to the label the same
   *  way it does in Fleet / Investigate. Other cards omit it. */
  icon?: ReactNode;
  active: boolean;
  onClick: () => void;
}

function SummaryCard({
  label,
  value,
  sub,
  changePct,
  icon,
  active,
  onClick,
}: CardSpec) {
  return (
    <Card
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        "flex-1 min-w-[180px] cursor-pointer transition-colors",
        "border",
        active ? "border-[color:var(--accent)]" : "border-[color:var(--border)]",
        "hover:bg-[color:var(--surface-hover)]",
      )}
      style={
        active
          ? { boxShadow: "inset 0 0 0 1px var(--accent)" }
          : undefined
      }
    >
      <CardContent className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-[13px] text-text-muted">{label}</span>
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-bold text-text">{value}</span>
          {changePct !== undefined && Number.isFinite(changePct) && (
            <span
              className={cn(
                "text-xs font-medium",
                changePct >= 0 ? "text-success" : "text-danger",
              )}
            >
              {changePct >= 0 ? "+" : ""}
              {changePct.toFixed(1)}%
            </span>
          )}
        </div>
        {sub && <span className="text-[11px] text-text-muted">{sub}</span>}
      </CardContent>
    </Card>
  );
}

export function SummaryCards({
  range,
  from,
  to,
  filterProvider,
  onSelectProvider,
}: SummaryCardsProps) {
  const [tokensTotal, setTokensTotal] = useState<Totals | null>(null);
  const [anthropicTotal, setAnthropicTotal] = useState<Totals | null>(null);
  const [openaiTotal, setOpenaiTotal] = useState<Totals | null>(null);
  const [sessionsTotal, setSessionsTotal] = useState<Totals | null>(null);

  useEffect(() => {
    let cancelled = false;
    const base = { range, from, to };
    Promise.all([
      total({ ...base, metric: "tokens", group_by: "flavor" }),
      total({ ...base, metric: "tokens", group_by: "flavor", filter_provider: "anthropic" }),
      total({ ...base, metric: "tokens", group_by: "flavor", filter_provider: "openai" }),
      total({ ...base, metric: "sessions", group_by: "flavor" }),
    ])
      .then(([tokens, anthropic, openai, sessions]) => {
        if (cancelled) return;
        setTokensTotal(tokens);
        setAnthropicTotal(anthropic);
        setOpenaiTotal(openai);
        setSessionsTotal(sessions);
      })
      .catch(() => {
        /* swallow -- cards render in their loading state */
      });
    return () => {
      cancelled = true;
    };
  }, [range, from, to]);

  const loading =
    tokensTotal === null ||
    anthropicTotal === null ||
    openaiTotal === null ||
    sessionsTotal === null;

  const totalTokens = tokensTotal?.value ?? 0;
  const anthropicPct =
    tokensTotal && totalTokens > 0
      ? ((anthropicTotal?.value ?? 0) / totalTokens) * 100
      : 0;
  const openaiPct =
    tokensTotal && totalTokens > 0
      ? ((openaiTotal?.value ?? 0) / totalTokens) * 100
      : 0;
  const avgPerSession =
    sessionsTotal && sessionsTotal.value > 0
      ? totalTokens / sessionsTotal.value
      : 0;

  if (loading) {
    return (
      <div className="flex gap-4 flex-wrap" data-testid="summary-cards-loading">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="flex-1 min-w-[180px] h-[72px] rounded-md bg-surface animate-pulse"
          />
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-4 flex-wrap">
      <SummaryCard
        label="Total Tokens"
        value={formatCompact(totalTokens)}
        sub={null}
        changePct={tokensTotal?.changePct}
        active={filterProvider === null}
        onClick={() => onSelectProvider(null)}
      />
      {/* Only render a provider card if that provider actually
          contributed tokens this period. With flex-wrap + flex-1 the
          surviving cards expand to fill the row evenly, which is why
          no ghost placeholder is needed here. */}
      {(anthropicTotal?.value ?? 0) > 0 && (
        <SummaryCard
          label={`${PROVIDER_META.anthropic.label} Tokens`}
          value={formatCompact(anthropicTotal?.value ?? 0)}
          sub={`${anthropicPct.toFixed(1)}% of total`}
          icon={<ProviderLogo provider="anthropic" size={14} />}
          active={filterProvider === "anthropic"}
          onClick={() =>
            onSelectProvider(filterProvider === "anthropic" ? null : "anthropic")
          }
        />
      )}
      {(openaiTotal?.value ?? 0) > 0 && (
        <SummaryCard
          label={`${PROVIDER_META.openai.label} Tokens`}
          value={formatCompact(openaiTotal?.value ?? 0)}
          sub={`${openaiPct.toFixed(1)}% of total`}
          icon={<ProviderLogo provider="openai" size={14} />}
          active={filterProvider === "openai"}
          onClick={() =>
            onSelectProvider(filterProvider === "openai" ? null : "openai")
          }
        />
      )}
      <SummaryCard
        label="Total Sessions"
        value={formatCompact(sessionsTotal?.value ?? 0)}
        sub={null}
        changePct={sessionsTotal?.changePct}
        active={filterProvider === null}
        onClick={() => onSelectProvider(null)}
      />
      <SummaryCard
        label="Avg Tokens / Session"
        value={formatCompact(avgPerSession)}
        sub={null}
        active={filterProvider === null}
        onClick={() => onSelectProvider(null)}
      />
    </div>
  );
}
