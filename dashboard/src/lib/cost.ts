import type { AgentSummaryTotals } from "@/lib/types";

export type CostTotals = Pick<
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

/** What an empty cost chart means, from the window's billing modes: no
 *  calls at all, only subscription calls (nothing is metered), or
 *  metered calls that came to nothing priced. */
export function costEmptyMessage(billingModes: string[] | undefined): string {
  if (!billingModes || billingModes.length === 0) {
    return "No LLM calls in this period.";
  }
  if (isSubscriptionOnly(billingModes)) {
    return "Every call in this period ran on a subscription plan, so there is no metered cost.";
  }
  return "No metered cost in this period.";
}
