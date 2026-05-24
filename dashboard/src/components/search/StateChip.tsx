import type { SessionState } from "@/lib/types";

/** Compact session/agent state chip. Active runs get a green
 *  tint (matching the run-row chip pattern that predates this
 *  refactor); every other state gets a neutral surface tint.
 *  Shared by AgentRow + SessionRow in SearchResults so a
 *  "stale" agent and a "stale" run read identically.
 *
 *  state="" (no rolled-up state for an agent with no sessions)
 *  renders null — the row simply omits the chip in that case.
 */
const ACTIVE_STATE: SessionState = "active";

export function StateChip({ state }: { state: SessionState | "" }) {
  if (!state) return null;
  const isActive = state === ACTIVE_STATE;
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${
        isActive
          ? "bg-green-500/20 text-green-400"
          : "bg-surface-hover text-text-muted"
      }`}
    >
      {state}
    </span>
  );
}
