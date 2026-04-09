import { useMemo, useState } from "react";
import type { AgentEvent } from "@/lib/types";
import { isEventVisible } from "@/lib/events";

const BUCKET_COUNT = 24;
const MAX_HEIGHT = 36;

const EVENT_CATEGORIES = [
  { key: "llm", match: (t: string) => t === "pre_call" || t === "post_call", color: "var(--event-llm)" },
  { key: "tool", match: (t: string) => t === "tool_call", color: "var(--event-tool)" },
  { key: "policy", match: (t: string) => t.startsWith("policy_"), color: "var(--event-warn)" },
  { key: "directive", match: (t: string) => t === "directive_result" || t === "directive", color: "var(--event-directive)" },
] as const;

interface BarViewProps {
  events: AgentEvent[];
  start: Date;
  end: Date;
  width: number;
  activeFilter?: string | null;
}

export function BarView({ events, start, end, width, activeFilter }: BarViewProps) {
  const [hoveredBucket, setHoveredBucket] = useState<number | null>(null);

  const buckets = useMemo(() => {
    const rangeMs = end.getTime() - start.getTime();
    const bucketMs = rangeMs / BUCKET_COUNT;
    const result: { llm: number; tool: number; policy: number; directive: number }[] = [];
    for (let i = 0; i < BUCKET_COUNT; i++) {
      result.push({ llm: 0, tool: 0, policy: 0, directive: 0 });
    }

    for (const evt of events) {
      // Skip events that don't match the active filter
      if (!isEventVisible(evt.event_type, activeFilter)) continue;

      const t = new Date(evt.occurred_at).getTime();
      const idx = Math.min(
        Math.floor((t - start.getTime()) / bucketMs),
        BUCKET_COUNT - 1
      );
      if (idx < 0) continue;
      for (const cat of EVENT_CATEGORIES) {
        if (cat.match(evt.event_type)) {
          result[idx][cat.key]++;
          break;
        }
      }
    }
    return result;
  }, [events, start, end, activeFilter]);

  const maxCount = Math.max(1, ...buckets.map((b) => b.llm + b.tool + b.policy + b.directive));
  const barWidth = Math.max(1, (width / BUCKET_COUNT) - 2);

  return (
    <div className="relative flex items-end gap-[2px]" style={{ height: MAX_HEIGHT }}>
      {buckets.map((bucket, i) => {
        const total = bucket.llm + bucket.tool + bucket.policy + bucket.directive;
        const barH = total > 0 ? Math.max(2, (total / maxCount) * MAX_HEIGHT) : 0;

        return (
          <div
            key={i}
            className="relative flex flex-col justify-end"
            style={{ width: barWidth, height: MAX_HEIGHT }}
            onMouseEnter={() => setHoveredBucket(i)}
            onMouseLeave={() => setHoveredBucket(null)}
          >
            {total === 0 ? (
              <div
                className="w-full"
                style={{ height: 1, background: "var(--border-subtle)" }}
              />
            ) : (
              <div className="flex flex-col justify-end" style={{ height: barH }}>
                {EVENT_CATEGORIES.map((cat) => {
                  const count = bucket[cat.key];
                  if (count === 0) return null;
                  const h = (count / total) * barH;
                  return (
                    <div
                      key={cat.key}
                      style={{ height: h, background: cat.color, minHeight: 1 }}
                    />
                  );
                })}
              </div>
            )}

            {hoveredBucket === i && total > 0 && (
              <div
                className="absolute bottom-full left-1/2 z-50 mb-1 -translate-x-1/2 whitespace-nowrap rounded px-2 py-1 text-[11px]"
                style={{
                  background: "var(--bg-elevated)",
                  border: "1px solid var(--border)",
                  color: "var(--text)",
                }}
              >
                {bucket.llm > 0 && <div>LLM: {bucket.llm}</div>}
                {bucket.tool > 0 && <div>Tool: {bucket.tool}</div>}
                {bucket.policy > 0 && <div>Policy: {bucket.policy}</div>}
                {bucket.directive > 0 && <div>Directive: {bucket.directive}</div>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
