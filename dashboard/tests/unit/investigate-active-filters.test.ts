import { describe, it, expect, vi } from "vitest";
import {
  buildActiveFilters,
  CLEAR_ALL_FILTERS_PATCH,
  collectFacetSources,
  parseUrlState,
  type FacetSources,
} from "@/pages/Investigate";
import type { SessionListItem } from "@/lib/types";

// ---- helpers -------------------------------------------------------------

function urlState(overrides: Partial<URLSearchParams[keyof URLSearchParams]> | string) {
  const sp =
    typeof overrides === "string"
      ? new URLSearchParams(overrides)
      : new URLSearchParams(overrides as unknown as string);
  return parseUrlState(sp);
}

function mkSession(partial: Partial<SessionListItem>): SessionListItem {
  return {
    session_id: partial.session_id ?? "00000000-0000-0000-0000-000000000000",
    flavor: partial.flavor ?? "test-flavor",
    agent_type: partial.agent_type ?? "production",
    agent_id: partial.agent_id,
    agent_name: partial.agent_name,
    client_type: partial.client_type,
    host: partial.host ?? null,
    model: partial.model ?? null,
    state: partial.state ?? "active",
    started_at: partial.started_at ?? "",
    ended_at: partial.ended_at ?? null,
    duration_s: partial.duration_s ?? 0,
    tokens_used: partial.tokens_used ?? 0,
    token_limit: partial.token_limit ?? null,
    context: partial.context ?? {},
    capture_enabled: partial.capture_enabled ?? false,
    token_id: partial.token_id ?? null,
    token_name: partial.token_name ?? null,
  };
}

// ---- buildActiveFilters / agent_id chip ---------------------------------

describe("buildActiveFilters -- agent_id chip", () => {
  it("emits a chip when urlState.agentId is set", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    const state = urlState(`agent_id=${uuid}`);
    const sessions = [
      mkSession({
        session_id: "s1",
        agent_id: uuid,
        agent_name: "omria@Omri-PC",
      }),
    ];
    const pills = buildActiveFilters(state, sessions, () => {});
    expect(pills.map((p) => p.label)).toContain("agent:omria@Omri-PC");
  });

  it("falls back to 8-char UUID prefix when no session matches", () => {
    // Regression scenario: a filter that returns 0 sessions. The
    // chip must still render so the user can remove the filter.
    const uuid = "abcdef12-0000-0000-0000-000000000000";
    const state = urlState(`agent_id=${uuid}`);
    const pills = buildActiveFilters(state, [], () => {});
    expect(pills.map((p) => p.label)).toContain("agent:abcdef12");
  });

  it("onRemove clears agentId and resets page", () => {
    const state = urlState("agent_id=xyz");
    const updateUrl = vi.fn();
    const pills = buildActiveFilters(state, [], updateUrl);
    const chip = pills.find((p) => p.label.startsWith("agent:"));
    expect(chip).toBeDefined();
    chip!.onRemove();
    expect(updateUrl).toHaveBeenCalledWith({ agentId: "", page: 1 });
  });

  it("emits no agent chip when urlState.agentId is empty", () => {
    const state = urlState(""); // no agent filter
    const pills = buildActiveFilters(state, [], () => {});
    expect(pills.filter((p) => p.label.startsWith("agent:"))).toHaveLength(0);
  });
});

// ---- CLEAR_ALL_FILTERS_PATCH --------------------------------------------

describe("CLEAR_ALL_FILTERS_PATCH", () => {
  it("includes agentId: \"\" so clearing drops the D115 agent filter", () => {
    // Regression guard for bug (c): the clearAllFilters patch omitted
    // agentId, so clicking "Clear all filters" cleared every other
    // facet but preserved the agent_id URL param silently.
    expect(CLEAR_ALL_FILTERS_PATCH.agentId).toBe("");
  });

  it("resets every filter-bearing URL state field", () => {
    // Structural guard: if someone adds a new filter to parseUrlState
    // they must also extend CLEAR_ALL_FILTERS_PATCH. This spot-check
    // lists the fields we care about; adding a new filter means
    // adding an expectation here.
    expect(CLEAR_ALL_FILTERS_PATCH.states).toEqual([]);
    expect(CLEAR_ALL_FILTERS_PATCH.flavors).toEqual([]);
    expect(CLEAR_ALL_FILTERS_PATCH.agentTypes).toEqual([]);
    expect(CLEAR_ALL_FILTERS_PATCH.frameworks).toEqual([]);
    expect(CLEAR_ALL_FILTERS_PATCH.agentId).toBe("");
    expect(CLEAR_ALL_FILTERS_PATCH.model).toBe("");
    expect(CLEAR_ALL_FILTERS_PATCH.q).toBe("");
    expect(CLEAR_ALL_FILTERS_PATCH.page).toBe(1);
  });
});

// ---- collectFacetSources -- graceful degradation on aux rejection -------

describe("collectFacetSources -- allSettled fold", () => {
  const s1 = mkSession({ session_id: "s1" });
  const s2 = mkSession({ session_id: "s2" });

  it("lands fulfilled entries in the sources map", () => {
    const settled: PromiseSettledResult<readonly [string, SessionListItem[] | undefined]>[] = [
      { status: "fulfilled", value: ["model", [s1, s2]] as const },
      { status: "fulfilled", value: ["flavor", [s1]] as const },
    ];
    const sources = collectFacetSources(settled, ["model", "flavor"]);
    expect(sources.model).toEqual([s1, s2]);
    expect(sources.flavor).toEqual([s1]);
  });

  it("drops rejected entries and logs a fallback warning", () => {
    // This is the regression guard for bug (a): even when one aux
    // fetch rejects (e.g. the old limit=500 / cap 100 mismatch), the
    // fold returns a map with every SUCCESSFUL entry intact. The
    // caller keeps its main-table setState (wired in doFetch to run
    // BEFORE this fold) and degrades gracefully on the failed
    // dimension.
    const log = vi.fn();
    const settled: PromiseSettledResult<readonly [string, SessionListItem[] | undefined]>[] = [
      { status: "fulfilled", value: ["model", [s1]] as const },
      { status: "rejected", reason: new Error("HTTP 400: limit exceeds maximum of 100") },
      { status: "fulfilled", value: ["flavor", [s2]] as const },
    ];
    const sources = collectFacetSources(settled, ["model", "agent_id", "flavor"], log);
    expect(sources.model).toEqual([s1]);
    expect(sources.agent_id).toBeUndefined();
    expect(sources.flavor).toEqual([s2]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`aux facet-source fetch for "agent_id" failed`),
      expect.any(Error),
    );
  });

  it("does not log AbortError rejections (superseded fetch is expected)", () => {
    const log = vi.fn();
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    const settled: PromiseSettledResult<readonly [string, SessionListItem[] | undefined]>[] = [
      { status: "rejected", reason: abortError },
    ];
    const sources = collectFacetSources(settled, ["flavor"], log);
    expect(sources).toEqual({} as FacetSources);
    expect(log).not.toHaveBeenCalled();
  });
});
