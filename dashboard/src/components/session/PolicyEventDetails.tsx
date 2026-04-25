import { useState } from "react";
import type { AgentEvent } from "@/lib/types";

/**
 * Collapsible details block rendered inside the expanded view of a
 * ``policy_warn`` / ``policy_degrade`` / ``policy_block`` event.
 * Sibling to ``ErrorEventDetails`` — same accordion shape, same
 * per-field ``policy-event-detail-<field>-<id>`` testids for granular
 * E2E targeting.
 *
 * The summary grid at the top of the expanded row already carries
 * source / threshold / tokens / from-to-intended models. This
 * accordion holds the secondary fields a reader might want when
 * triaging an enforcement event but doesn't need to scan past:
 * cumulative token math (computed locally so an operator can verify
 * the sensor's threshold maths), and a one-line restatement of the
 * decision in human prose.
 */
export function PolicyEventDetails({ event }: { event: AgentEvent }) {
  const [expanded, setExpanded] = useState(false);
  const p = event.payload;
  if (!p) return null;

  // Cumulative percentage actually used at the time of the decision,
  // computed from the captured tokens_used / token_limit. Useful for
  // sanity-checking the threshold the policy fired against.
  let pctUsedAtDecision: string | null = null;
  if (p.tokens_used != null && p.token_limit != null && p.token_limit > 0) {
    const pct = Math.round((p.tokens_used * 100) / p.token_limit);
    pctUsedAtDecision = `${pct}% of limit`;
  }

  // Human one-liner, distinct per type. Reads naturally so a reader
  // can paste it into a Slack thread without composing.
  let plainEnglish = "";
  switch (event.event_type) {
    case "policy_warn":
      plainEnglish =
        p.source === "local"
          ? "Local init() limit threshold crossed; the call proceeded."
          : "Server policy warn threshold crossed; the call proceeded.";
      break;
    case "policy_degrade":
      plainEnglish = `Server policy armed model degrade (${p.from_model ?? "?"} → ${p.to_model ?? "?"}); subsequent calls use the degraded model.`;
      break;
    case "policy_block":
      plainEnglish = `Server policy blocked the call before dispatch; ${p.intended_model ?? "the call"} never ran.`;
      break;
    default:
      plainEnglish = "";
  }

  return (
    <div
      data-testid={`policy-event-details-${event.id}`}
      className="mt-2"
      style={{
        borderTop: "1px solid var(--border-subtle)",
        paddingTop: 8,
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        data-testid={`policy-event-details-toggle-${event.id}`}
        className="flex items-center gap-2 text-left transition-colors hover:bg-surface-hover"
        style={{
          padding: "2px 4px",
          borderRadius: 3,
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-secondary)",
          width: "100%",
        }}
      >
        <span
          style={{
            display: "inline-block",
            transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
            transition: "transform 150ms ease",
            color: "var(--text-muted)",
          }}
        >
          ▶
        </span>
        <span>Policy details</span>
      </button>
      {expanded && (
        <div
          className="mt-2 grid gap-x-3 gap-y-1"
          style={{ gridTemplateColumns: "120px 1fr" }}
        >
          {pctUsedAtDecision && (
            <DetailRow
              label="Pct at decision"
              value={pctUsedAtDecision}
              testId={`policy-event-detail-pct-used-${event.id}`}
            />
          )}
          {p.source && (
            <DetailRow
              label="Source"
              value={
                p.source === "local"
                  ? "init() limit (local)"
                  : "server policy"
              }
              testId={`policy-event-detail-source-${event.id}`}
            />
          )}
          {plainEnglish && (
            <DetailRow
              label="Summary"
              value={plainEnglish}
              testId={`policy-event-detail-summary-${event.id}`}
            />
          )}
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  testId,
}: {
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <>
      <span
        className="text-[11px]"
        style={{ color: "var(--text-muted)" }}
      >
        {label}
      </span>
      <span
        data-testid={testId}
        className="text-xs"
        style={{ color: "var(--text)", wordBreak: "break-word" }}
      >
        {value}
      </span>
    </>
  );
}
