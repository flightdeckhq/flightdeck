import type { AgentSummaryTotals } from "@/lib/types";
import { formatCost } from "@/lib/agents-format";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

type CostTotals = Pick<
  AgentSummaryTotals,
  "cost_usd" | "partial_estimate" | "models_unpriced" | "billing_modes"
>;

/** True when every LLM call in the window ran on a subscription plan,
 *  so there is no per-call cost to show. An empty list (no calls) is
 *  not subscription-only: the agent simply spent nothing. */
export function isSubscriptionOnly(billingModes: string[] | undefined): boolean {
  return (
    !!billingModes &&
    billingModes.length > 0 &&
    billingModes.every((m) => m === "subscription")
  );
}

/** What a cost total leaves out, one sentence per gap, for the partial
 *  marker's tooltip. Empty when the total is complete. */
export function costCaveats(totals: CostTotals): string[] {
  const caveats: string[] = [];
  // The API always sends both lists; tolerate their absence anyway so a
  // summary from an older API reads as complete instead of failing.
  const unpriced = totals.models_unpriced ?? [];
  if (totals.partial_estimate && unpriced.length > 0) {
    caveats.push(`Excludes calls to models with no price: ${unpriced.join(", ")}.`);
  }
  if ((totals.billing_modes ?? []).includes("subscription")) {
    caveats.push("Excludes calls that ran on a subscription plan.");
  }
  return caveats;
}

/** An agent's metered cost for a window, as the Agents table and the
 *  per-agent modal show it: `Subscription` when nothing was metered, the
 *  amount otherwise, with a marker whose tooltip names what the amount
 *  leaves out (unpriced models, subscription calls). */
export function AgentCost({
  totals,
  testId,
}: {
  totals: CostTotals | null | undefined;
  testId: string;
}) {
  if (!totals) {
    return <span data-testid={testId}>—</span>;
  }
  if (isSubscriptionOnly(totals.billing_modes)) {
    return (
      <span
        data-testid={testId}
        data-cost-state="subscription"
        className="text-text-muted"
        title="Every call in this window ran on a subscription plan, so there is no per-call cost."
      >
        Subscription
      </span>
    );
  }
  const caveats = costCaveats(totals);
  return (
    <span
      data-testid={testId}
      data-cost-state={caveats.length > 0 ? "partial" : "complete"}
      className="inline-flex items-baseline gap-0.5"
    >
      {formatCost(totals.cost_usd)}
      {caveats.length > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                data-testid={`${testId}-partial`}
                tabIndex={0}
                aria-label={`Partial cost. ${caveats.join(" ")}`}
                className="cursor-help text-warning"
              >
                *
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {caveats.map((c) => (
                <p key={c}>{c}</p>
              ))}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </span>
  );
}
