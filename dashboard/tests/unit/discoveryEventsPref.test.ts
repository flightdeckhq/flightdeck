import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  isDiscoveryEvent,
  MCP_DISCOVERY_EVENT_TYPES,
} from "@/lib/events";
import {
  readShowDiscoveryEvents,
  persistShowDiscoveryEvents,
  useShowDiscoveryEvents,
} from "@/lib/discoveryEventsPref";
import { FEED_SHOW_DISCOVERY_EVENTS_KEY } from "@/lib/constants";

// D122 — predicate + persisted-preference tests. Lock down the
// closed-set membership of MCP_DISCOVERY_EVENT_TYPES (so adding a new
// MCP event_type to the canon doesn't accidentally inherit discovery
// hiding) and the localStorage round-trip contract.

describe("isDiscoveryEvent (D122)", () => {
  it("returns true for the three list/discovery MCP types", () => {
    expect(isDiscoveryEvent("mcp_tool_list")).toBe(true);
    expect(isDiscoveryEvent("mcp_resource_list")).toBe(true);
    expect(isDiscoveryEvent("mcp_prompt_list")).toBe(true);
  });

  it("returns false for the three usage MCP types", () => {
    expect(isDiscoveryEvent("mcp_tool_call")).toBe(false);
    expect(isDiscoveryEvent("mcp_resource_read")).toBe(false);
    expect(isDiscoveryEvent("mcp_prompt_get")).toBe(false);
  });

  it("returns false for non-MCP event_types", () => {
    expect(isDiscoveryEvent("post_call")).toBe(false);
    expect(isDiscoveryEvent("tool_call")).toBe(false);
    expect(isDiscoveryEvent("session_start")).toBe(false);
    expect(isDiscoveryEvent("policy_block")).toBe(false);
    expect(isDiscoveryEvent("llm_error")).toBe(false);
    expect(isDiscoveryEvent("embeddings")).toBe(false);
  });

  it("returns false for unknown / arbitrary strings", () => {
    expect(isDiscoveryEvent("")).toBe(false);
    expect(isDiscoveryEvent("MCP_TOOL_LIST")).toBe(false); // case-sensitive
    expect(isDiscoveryEvent("mcp_tool_list_extra")).toBe(false);
    expect(isDiscoveryEvent("not_an_event")).toBe(false);
  });

  it("MCP_DISCOVERY_EVENT_TYPES export is the closed set of three", () => {
    expect([...MCP_DISCOVERY_EVENT_TYPES]).toEqual([
      "mcp_tool_list",
      "mcp_resource_list",
      "mcp_prompt_list",
    ]);
  });
});

describe("readShowDiscoveryEvents / persistShowDiscoveryEvents (D122)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("default off when localStorage is empty", () => {
    expect(readShowDiscoveryEvents()).toBe(false);
  });

  it("round-trips a true value through localStorage", () => {
    persistShowDiscoveryEvents(true);
    expect(readShowDiscoveryEvents()).toBe(true);
    expect(localStorage.getItem(FEED_SHOW_DISCOVERY_EVENTS_KEY)).toBe("true");
  });

  it("round-trips a false value through localStorage", () => {
    persistShowDiscoveryEvents(false);
    expect(readShowDiscoveryEvents()).toBe(false);
    expect(localStorage.getItem(FEED_SHOW_DISCOVERY_EVENTS_KEY)).toBe("false");
  });

  it("falls back to false on invalid stored values", () => {
    // Anything other than the literal string "true" reads as false.
    // Lock the parser down so a future writer that drops a JSON
    // object or a stray "1" / "yes" / "on" doesn't accidentally
    // flip the toggle.
    for (const garbage of ["1", "yes", "on", "TRUE", '{"v":true}', "  true  "]) {
      localStorage.setItem(FEED_SHOW_DISCOVERY_EVENTS_KEY, garbage);
      expect(readShowDiscoveryEvents()).toBe(false);
    }
  });

  it("survives localStorage being unavailable", () => {
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("storage disabled");
    };
    try {
      expect(readShowDiscoveryEvents()).toBe(false);
    } finally {
      Storage.prototype.getItem = original;
    }
  });
});

describe("useShowDiscoveryEvents (D122)", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initialises from localStorage default (false)", () => {
    const { result } = renderHook(() => useShowDiscoveryEvents());
    expect(result.current[0]).toBe(false);
  });

  it("initialises from localStorage when previously set to true", () => {
    localStorage.setItem(FEED_SHOW_DISCOVERY_EVENTS_KEY, "true");
    const { result } = renderHook(() => useShowDiscoveryEvents());
    expect(result.current[0]).toBe(true);
  });

  it("setShown updates state and writes through to localStorage", () => {
    const { result } = renderHook(() => useShowDiscoveryEvents());
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem(FEED_SHOW_DISCOVERY_EVENTS_KEY)).toBe("true");
  });

  it("multiple subscribers stay in sync via the same-tab CustomEvent", () => {
    const { result: a } = renderHook(() => useShowDiscoveryEvents());
    const { result: b } = renderHook(() => useShowDiscoveryEvents());
    expect(a.current[0]).toBe(false);
    expect(b.current[0]).toBe(false);
    // Toggle from subscriber A; B should observe the new value via
    // the dispatched CustomEvent without an explicit re-render.
    act(() => a.current[1](true));
    expect(a.current[0]).toBe(true);
    expect(b.current[0]).toBe(true);
  });
});
