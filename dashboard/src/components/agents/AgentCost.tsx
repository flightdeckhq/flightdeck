import { formatCost } from "@/lib/agents-format";
import { costCaveats, isSubscriptionOnly, type CostTotals } from "@/lib/cost";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
              {/* A button so keyboard and screen-reader users reach the
                  caveat; clicks stop here so the Agents row does not
                  navigate away. */}
              <button
                type="button"
                data-testid={`${testId}-partial`}
                aria-label={`Partial cost. ${caveats.join(" ")}`}
                className="cursor-help text-warning"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                *
              </button>
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
