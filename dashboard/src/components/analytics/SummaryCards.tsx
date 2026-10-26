import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { fetchAnalytics } from "@/lib/api";
import { PROVIDER_META, isProvider, type Provider } from "@/lib/models";
import { ProviderLogo } from "@/components/ui/provider-logo";

/**
 * Row 1 of the Analytics page -- summary cards: total tokens, one card
 * per provider that used tokens in the window (from a single
 * ``group_by=provider`` query, largest first), total runs, and average
 * tokens per run.
 *
 * Cards are clickable: selecting a provider card promotes that provider
 * into the `filter_provider` slot that every chart below reads via the
 * page's shared AnalyticsFilters state, so the whole page reflows to
 * that provider without a separate filter control. Clicking Total
 * Tokens / Total Runs / Avg clears the provider filter (they are "show
 * everything" cards).
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

interface ProviderTotal {
  provider: Provider;
  value: number;
}

interface CardData {
  tokens: Totals;
  sessions: Totals;
  providers: ProviderTotal[];
}

/** One tokens query grouped by provider gives the grand total and the
 *  per-provider split; one sessions query gives the run count. */
async function loadCards(base: Record<string, string | undefined>): Promise<CardData> {
  const [byProvider, sessions] = await Promise.all([
    fetchAnalytics({ ...base, metric: "tokens", group_by: "provider" }),
    fetchAnalytics({ ...base, metric: "sessions", group_by: "flavor" }),
  ]);
  return {
    tokens: {
      value: byProvider.totals.grand_total,
      changePct: byProvider.totals.period_change_pct,
    },
    sessions: {
      value: sessions.totals.grand_total,
      changePct: sessions.totals.period_change_pct,
    },
    providers: providerTotals(byProvider.series),
  };
}

/** Per-provider token totals, largest first. A dimension outside the
 *  provider vocabulary counts toward Other, so each provider has at most
 *  one card. */
function providerTotals(series: { dimension: string; total: number }[]): ProviderTotal[] {
  const totals = new Map<Provider, number>();
  for (const s of series) {
    if (s.total <= 0) continue;
    const provider: Provider = isProvider(s.dimension) ? s.dimension : "other";
    totals.set(provider, (totals.get(provider) ?? 0) + s.total);
  }
  return [...totals]
    .map(([provider, value]) => ({ provider, value }))
    .sort((x, y) => y.value - x.value);
}

/** A provider's share of all tokens: one decimal place, and `<0.1%`
 *  for a share too small to show (so real usage never reads as 0.0%). */
function formatShare(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  const pct = (part / whole) * 100;
  return pct < 0.1 ? "<0.1%" : `${pct.toFixed(1)}%`;
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
  testId?: string;
}

function SummaryCard({
  label,
  value,
  sub,
  changePct,
  icon,
  active,
  onClick,
  testId,
}: CardSpec) {
  return (
    <Card
      data-testid={testId}
      data-active={active ? "true" : undefined}
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
        active ? "border-(--accent)" : "border-(--border)",
        "hover:bg-(--surface-hover)",
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
  const [cards, setCards] = useState<CardData | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadCards({ range, from, to })
      .then((data) => {
        if (!cancelled) setCards(data);
      })
      .catch(() => {
        /* swallow -- cards render in their loading state */
      });
    return () => {
      cancelled = true;
    };
  }, [range, from, to]);

  const loading = cards === null;
  const totalTokens = cards?.tokens.value ?? 0;
  const runs = cards?.sessions.value ?? 0;
  const avgPerSession = runs > 0 ? totalTokens / runs : 0;

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
        changePct={cards?.tokens.changePct}
        active={filterProvider === null}
        onClick={() => onSelectProvider(null)}
      />
      {/* One card per provider that used tokens in the window. With
          flex-wrap + flex-1 the cards share the row evenly whatever
          their number. */}
      {cards?.providers.map(({ provider, value }) => (
        <SummaryCard
          key={provider}
          label={`${PROVIDER_META[provider].label} Tokens`}
          value={formatCompact(value)}
          sub={`${formatShare(value, totalTokens)} of total`}
          icon={<ProviderLogo provider={provider} size={14} />}
          active={filterProvider === provider}
          onClick={() =>
            onSelectProvider(filterProvider === provider ? null : provider)
          }
          testId={`summary-card-provider-${provider}`}
        />
      ))}
      <SummaryCard
        label="Total Runs"
        value={formatCompact(runs)}
        sub={null}
        changePct={cards?.sessions.changePct}
        active={filterProvider === null}
        onClick={() => onSelectProvider(null)}
      />
      <SummaryCard
        label="Avg Tokens / Run"
        value={formatCompact(avgPerSession)}
        sub={null}
        active={filterProvider === null}
        onClick={() => onSelectProvider(null)}
      />
    </div>
  );
}
