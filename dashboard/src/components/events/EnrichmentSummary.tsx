import type { AgentEvent, PolicyDecisionBlock } from "@/lib/types";

interface EnrichmentSummaryProps {
  event: AgentEvent;
  /** When set, callback to navigate to the originating event in the
   * same drawer (jumps the drawer to event.payload.originating_event_id). */
  onJumpToOriginator?: (originatingEventId: string) => void;
}

/**
 * Renders the operator-actionable enrichment block on the event
 * detail drawer. Surfaces every field the row chips condense
 * inline — full reason strings, full provider_metadata table,
 * close_reason / policy_actions_summary on session_end, etc.
 *
 * Sections render in fixed order; each is hidden when the event
 * has no data for it. The component degrades to a single render
 * call (no sections) when the event carries no enrichment, so it
 * is safe to mount unconditionally.
 */
export function EnrichmentSummary({
  event,
  onJumpToOriginator,
}: EnrichmentSummaryProps) {
  const p = event.payload ?? {};

  const hasContent =
    p.policy_decision != null
    || p.policy_decision_pre != null
    || p.policy_decision_post != null
    || p.policy_decision_at_attach != null
    || p.provider_metadata != null
    || p.output_dimensions != null
    || p.retry_attempt != null
    || p.terminal != null
    || p.estimated_via != null
    || p.policy_actions_summary != null
    || p.policy_entries_orphaned != null
    || p.close_reason != null
    || p.last_event_id != null
    || p.sensor_version != null
    || p.interceptor_versions != null
    || p.policy_snapshot != null
    || p.originating_event_id != null;

  if (!hasContent) return null;

  return (
    <div className="space-y-3" data-testid="enrichment-summary">
      {p.originating_event_id && (
        <Section title="Originating call">
          <button
            className="font-mono text-xs underline-offset-2 hover:underline"
            style={{ color: "var(--accent)" }}
            onClick={() => onJumpToOriginator?.(p.originating_event_id!)}
            data-testid="originating-jump"
          >
            {p.originating_event_id.slice(0, 8)} ↗
          </button>
        </Section>
      )}

      {p.policy_decision_pre && (
        <PolicyDecisionRow title="Policy decision (pre-call)" block={p.policy_decision_pre} />
      )}
      {p.policy_decision_post && (
        <PolicyDecisionRow title="Policy decision (post-call)" block={p.policy_decision_post} />
      )}
      {p.policy_decision && (
        <PolicyDecisionRow title="Policy decision" block={p.policy_decision} />
      )}
      {p.policy_decision_at_attach && (
        <PolicyDecisionRow
          title="Policy decision (at attach)"
          block={p.policy_decision_at_attach}
        />
      )}

      {(p.estimated_via || p.retry_attempt != null || p.terminal != null) && (
        <Section title="Call attribution">
          <Grid>
            {p.estimated_via && (
              <Pair label="estimated_via" value={p.estimated_via} />
            )}
            {p.retry_attempt != null && (
              <Pair label="retry_attempt" value={String(p.retry_attempt)} />
            )}
            {p.terminal != null && (
              <Pair
                label="terminal"
                value={p.terminal ? "true" : "false"}
                accent={p.terminal ? "var(--event-block)" : undefined}
              />
            )}
          </Grid>
        </Section>
      )}

      {p.provider_metadata && (
        <Section title="Provider metadata">
          <Grid>
            {Object.entries(p.provider_metadata).map(([k, v]) => (
              <Pair key={k} label={k} value={String(v)} />
            ))}
          </Grid>
        </Section>
      )}

      {p.output_dimensions && (
        <Section title="Output dimensions">
          <Grid>
            <Pair label="count" value={String(p.output_dimensions.count)} />
            <Pair label="dimension" value={String(p.output_dimensions.dimension)} />
            <Pair
              label="total floats"
              value={(
                p.output_dimensions.count * p.output_dimensions.dimension
              ).toLocaleString()}
            />
          </Grid>
        </Section>
      )}

      {p.close_reason && (
        <Section title="Close reason">
          <span className="font-mono text-xs" style={{ color: "var(--text)" }}>
            {p.close_reason}
          </span>
          {p.last_event_id && (
            <span
              className="ml-2 font-mono text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              · last event {p.last_event_id.slice(0, 8)}
            </span>
          )}
        </Section>
      )}

      {p.policy_actions_summary && (
        <Section title="Policy actions in this session">
          <Grid>
            {Object.entries(p.policy_actions_summary).map(([k, v]) => (
              <Pair key={k} label={k} value={String(v)} />
            ))}
          </Grid>
        </Section>
      )}

      {p.policy_entries_orphaned && (
        <Section title="Orphaned policy entries">
          <Grid>
            <Pair
              label="count"
              value={String(p.policy_entries_orphaned.count)}
              accent="var(--event-warn)"
            />
            {p.policy_entries_orphaned.sample_entry_ids?.length > 0 && (
              <Pair
                label="sample IDs"
                value={p.policy_entries_orphaned.sample_entry_ids
                  .slice(0, 3)
                  .map((id) => id.slice(0, 8))
                  .join(", ")}
              />
            )}
          </Grid>
        </Section>
      )}

      {p.sensor_version && (
        <Section title="Sensor build">
          <Grid>
            <Pair label="sensor_version" value={p.sensor_version} />
            {p.interceptor_versions
              && Object.entries(p.interceptor_versions)
                .slice(0, 6)
                .map(([k, v]) => <Pair key={k} label={k} value={v} />)}
          </Grid>
        </Section>
      )}

      {p.policy_snapshot && (
        <Section title="Policy snapshot at session start">
          <Grid>
            {p.policy_snapshot.token_budget && (
              <>
                <Pair
                  label="token_budget.policy_id"
                  value={p.policy_snapshot.token_budget.policy_id.slice(0, 8)}
                />
                <Pair label="scope" value={p.policy_snapshot.token_budget.scope} />
              </>
            )}
            {p.policy_snapshot.mcp && (
              <>
                {p.policy_snapshot.mcp.global_policy_id && (
                  <Pair
                    label="mcp.global_policy_id"
                    value={p.policy_snapshot.mcp.global_policy_id.slice(0, 8)}
                  />
                )}
                {p.policy_snapshot.mcp.flavor_policy_id && (
                  <Pair
                    label="mcp.flavor_policy_id"
                    value={p.policy_snapshot.mcp.flavor_policy_id.slice(0, 8)}
                  />
                )}
                {p.policy_snapshot.mcp.flavor && (
                  <Pair label="mcp.flavor" value={p.policy_snapshot.mcp.flavor} />
                )}
              </>
            )}
          </Grid>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        className="mb-1 font-mono text-[10px] uppercase tracking-wide"
        style={{ color: "var(--text-muted)" }}
      >
        {title}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="grid gap-x-3 gap-y-0.5"
      style={{ gridTemplateColumns: "180px 1fr" }}
    >
      {children}
    </div>
  );
}

function Pair({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <>
      <span className="text-[11px]" style={{ color: "var(--text-muted)" }}>
        {label}
      </span>
      <span
        className="font-mono text-xs"
        style={{ color: accent ?? "var(--text)" }}
      >
        {value}
      </span>
    </>
  );
}

function PolicyDecisionRow({
  title,
  block,
}: {
  title: string;
  block: PolicyDecisionBlock;
}) {
  return (
    <Section title={title}>
      <Grid>
        <Pair
          label="decision"
          value={block.decision}
          accent={
            block.decision === "block" || block.decision === "deny"
              ? "var(--event-block)"
              : block.decision === "warn"
                ? "var(--event-warn)"
                : block.decision === "degrade"
                  ? "var(--event-degrade)"
                  : undefined
          }
        />
        <Pair label="scope" value={block.scope} />
        <Pair
          label="policy_id"
          value={
            block.policy_id === "local" ? "local" : block.policy_id.slice(0, 8)
          }
        />
        {block.matched_entry_label && (
          <Pair label="matched_entry" value={block.matched_entry_label} />
        )}
        {block.decision_path && (
          <Pair label="decision_path" value={block.decision_path} />
        )}
        <Pair label="reason" value={block.reason} />
      </Grid>
    </Section>
  );
}
