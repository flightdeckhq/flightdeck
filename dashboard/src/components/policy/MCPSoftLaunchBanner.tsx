import { useEffect, useState } from "react";
import { AlertCircle, X } from "lucide-react";

import {
  SOFT_LAUNCH_ACTIVE,
  SOFT_LAUNCH_BANNER_DISMISS_KEY,
} from "@/lib/constants";
import { cn } from "@/lib/utils";

/**
 * Renders the soft-launch heads-up at the top of the MCP Policies
 * page. Only shows when SOFT_LAUNCH_ACTIVE is true (v0.6) AND the
 * operator hasn't dismissed it for this dashboard install.
 *
 * Dismissal persists per-browser via localStorage. The banner does
 * not re-appear on subsequent visits unless localStorage is cleared
 * or SOFT_LAUNCH_ACTIVE flips back to true (which would only happen
 * via a deliberate constant edit + redeploy).
 *
 * Copy is precise and non-apologetic: it tells the operator what is
 * true now and how to opt out of the soft-launch behaviour at the
 * agent level. No "we're sorry" framing — this is documented
 * platform behaviour for v0.6.
 */
export function MCPSoftLaunchBanner() {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setDismissed(
      window.localStorage.getItem(SOFT_LAUNCH_BANNER_DISMISS_KEY) === "1",
    );
  }, []);

  if (!SOFT_LAUNCH_ACTIVE || dismissed) {
    return null;
  }

  const handleDismiss = () => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SOFT_LAUNCH_BANNER_DISMISS_KEY, "1");
    }
    setDismissed(true);
  };

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="mcp-soft-launch-banner"
      className={cn(
        "flex items-start gap-3 rounded-md border px-4 py-3",
        "border-amber-500/30 bg-amber-500/10 text-[var(--text)]",
      )}
    >
      <AlertCircle
        aria-hidden="true"
        className="mt-0.5 h-4 w-4 shrink-0 text-amber-500"
      />
      <div className="flex-1 text-sm leading-relaxed">
        <span className="font-semibold">Soft launch.</span>{" "}
        Policy <span className="font-medium">block</span> decisions
        are downgraded to <span className="font-medium">warn-only</span>{" "}
        through v0.6. Configured policy state is honoured for matching
        and event emission, but no agent calls are stopped.{" "}
        <span className="font-semibold">To opt an agent into full enforcement now</span>,
        set{" "}
        <code className="rounded bg-[var(--background-elevated)] px-1.5 py-0.5 font-mono text-xs">FLIGHTDECK_MCP_POLICY_DEFAULT=enforce</code>{" "}
        on that agent.
      </div>
      <button
        type="button"
        aria-label="Dismiss soft-launch notice"
        onClick={handleDismiss}
        data-testid="mcp-soft-launch-banner-dismiss"
        className={cn(
          "shrink-0 rounded p-1 text-[var(--text-muted)]",
          "hover:bg-[var(--background-elevated)] hover:text-[var(--text)]",
          "focus:outline-none focus:ring-2 focus:ring-[var(--accent)]",
        )}
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
