import { describe, it, expect } from "vitest";
import {
  parseEventsUrlState,
  buildEventsUrlParams,
} from "@/pages/Investigate";

describe("parseEventsUrlState", () => {
  it("applies event-grain defaults for an empty query string", () => {
    const s = parseEventsUrlState(new URLSearchParams());
    expect(s.eventTypes).toEqual([]);
    expect(s.errorTypes).toEqual([]);
    expect(s.models).toEqual([]);
    expect(s.frameworks).toEqual([]);
    expect(s.agentId).toBe("");
    expect(s.closeReasons).toEqual([]);
    expect(s.estimatedVia).toEqual([]);
    expect(s.matchedEntryIds).toEqual([]);
    expect(s.originatingCallContexts).toEqual([]);
    expect(s.mcpServers).toEqual([]);
    expect(s.terminalOnly).toBe(false);
    expect(s.run).toBe("");
    expect(s.page).toBe(1);
    expect(s.perPage).toBe(50);
  });

  it("reads repeatable facet params as arrays", () => {
    const sp = new URLSearchParams();
    sp.append("event_type", "post_call");
    sp.append("event_type", "tool_call");
    sp.append("error_type", "rate_limit");
    sp.append("mcp_server", "fixture-server");
    const s = parseEventsUrlState(sp);
    expect(s.eventTypes).toEqual(["post_call", "tool_call"]);
    expect(s.errorTypes).toEqual(["rate_limit"]);
    expect(s.mcpServers).toEqual(["fixture-server"]);
  });

  it("reads the run drawer deep-link param", () => {
    expect(parseEventsUrlState(new URLSearchParams("run=sess-1")).run).toBe(
      "sess-1",
    );
  });

  it("clamps per_page to the allowed set", () => {
    expect(parseEventsUrlState(new URLSearchParams("per_page=999")).perPage).toBe(
      50,
    );
    expect(parseEventsUrlState(new URLSearchParams("per_page=25")).perPage).toBe(
      25,
    );
    expect(
      parseEventsUrlState(new URLSearchParams("per_page=100")).perPage,
    ).toBe(100);
  });

  it("floors page at 1", () => {
    expect(parseEventsUrlState(new URLSearchParams("page=0")).page).toBe(1);
    expect(parseEventsUrlState(new URLSearchParams("page=-5")).page).toBe(1);
    expect(parseEventsUrlState(new URLSearchParams("page=4")).page).toBe(4);
  });
});

describe("buildEventsUrlParams round-trip", () => {
  it("round-trips a populated state through parse → build → parse", () => {
    const sp = new URLSearchParams();
    sp.append("event_type", "post_call");
    sp.append("error_type", "timeout");
    sp.append("model", "claude-sonnet-4-6");
    sp.append("framework", "langchain");
    sp.append("close_reason", "normal_exit");
    sp.append("estimated_via", "tiktoken");
    sp.append("matched_entry_id", "entry-1");
    sp.append("originating_call_context", "tool_call");
    sp.append("mcp_server", "fixture-server");
    sp.set("agent_id", "agent-1");
    sp.set("terminal", "true");
    sp.set("run", "sess-9");
    sp.set("page", "3");
    sp.set("per_page", "100");

    const parsed = parseEventsUrlState(sp);
    const rebuilt = parseEventsUrlState(buildEventsUrlParams(parsed));
    expect(rebuilt).toEqual(parsed);
  });

  it("omits default-valued params from the built query string", () => {
    const built = buildEventsUrlParams(
      parseEventsUrlState(new URLSearchParams()),
    );
    expect(built.has("page")).toBe(false);
    expect(built.has("per_page")).toBe(false);
    expect(built.has("terminal")).toBe(false);
    expect(built.has("run")).toBe(false);
  });
});
