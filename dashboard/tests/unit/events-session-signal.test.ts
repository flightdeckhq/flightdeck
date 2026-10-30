import { describe, it, expect } from "vitest";
import { EVENT_TYPE_GROUPS, getBadge, getEventDetail, getSummaryRows } from "@/lib/events";
import type { AgentEvent } from "@/lib/types";

// session_signal rendering at the pure-function layer: the feed line
// names the signal, the summary rows list its metadata.

function signal(name: string | undefined, data?: Record<string, string | number | boolean | null>): AgentEvent {
  return {
    id: "evt-1",
    session_id: "00000000-0000-0000-0000-000000000001",
    flavor: "claude-code",
    event_type: "session_signal",
    model: null,
    tokens_input: null,
    tokens_output: null,
    tokens_total: null,
    latency_ms: null,
    tool_name: null,
    has_content: false,
    occurred_at: "2026-10-30T10:00:00Z",
    payload: { signal: name, signal_data: data },
  } as AgentEvent;
}

describe("session_signal", () => {
  it("has its own badge and sits in the Run filter group", () => {
    expect(getBadge("session_signal").label).toBe("SIGNAL");
    expect(EVENT_TYPE_GROUPS.Run).toContain("session_signal");
  });

  it("names each known signal in the feed line", () => {
    expect(getEventDetail(signal("context_compaction_started", { trigger: "manual" }))).toBe(
      "compaction started · manual",
    );
    expect(getEventDetail(signal("context_compacted", { trigger: "auto" }))).toBe("context compacted · auto");
    expect(getEventDetail(signal("context_compacted"))).toBe("context compacted");
    expect(
      getEventDetail(
        signal("model_switched", { from_model: "claude-sonnet-5", to_model: "claude-opus-5", source: "command" }),
      ),
    ).toBe("model claude-sonnet-5 → claude-opus-5 · command");
  });

  it("shows an unknown signal by name and survives a missing one", () => {
    expect(getEventDetail(signal("worktree_created"))).toBe("worktree created");
    expect(getEventDetail(signal(undefined))).toBe("session signal");
  });

  it("lists the metadata with labels and formats", () => {
    const rows = getSummaryRows(
      signal("model_switched", {
        from_model: "claude-sonnet-5",
        to_model: "claude-opus-5",
        requested_model: null,
        source: "auto",
        context_tokens: 182340,
        prompt_cache_warm: true,
        cache_ttl: "5m",
        estimated_cache_write_usd: 1.1396,
        pricing: "catalog",
        brand_new_key: "x",
      }),
    );
    expect(rows).toEqual([
      ["Signal", "model switched"],
      ["From model", "claude-sonnet-5"],
      ["To model", "claude-opus-5"],
      ["Requested", "—"],
      ["Source", "auto"],
      ["Context tokens", (182340).toLocaleString()],
      ["Prompt cache warm", "yes"],
      ["Cache TTL", "5m"],
      ["Est. cache write", "$1.1396"],
      ["Pricing", "catalog"],
      ["brand_new_key", "x"],
    ]);
  });
});
