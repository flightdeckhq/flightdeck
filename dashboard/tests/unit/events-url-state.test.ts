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

  it("applies runtime-context defaults for an empty query string", () => {
    const s = parseEventsUrlState(new URLSearchParams());
    expect(s.osValues).toEqual([]);
    expect(s.archs).toEqual([]);
    expect(s.hosts).toEqual([]);
    expect(s.users).toEqual([]);
    expect(s.gitBranches).toEqual([]);
    expect(s.gitRepos).toEqual([]);
    expect(s.orchestrations).toEqual([]);
    expect(s.pythonVersions).toEqual([]);
    expect(s.processNames).toEqual([]);
  });

  it("reads repeatable runtime-context facet params as arrays", () => {
    const sp = new URLSearchParams();
    sp.append("os", "Linux");
    sp.append("os", "Darwin");
    sp.append("arch", "x86_64");
    sp.append("host", "ctx-host-a");
    sp.append("host", "ctx-host-b");
    sp.append("user", "omria");
    sp.append("git_branch", "feat/d160");
    sp.append("git_repo", "flightdeck");
    sp.append("orchestration", "k8s");
    sp.append("python_version", "3.12.4");
    sp.append("process_name", "sensor");
    const s = parseEventsUrlState(sp);
    expect(s.osValues).toEqual(["Linux", "Darwin"]);
    expect(s.archs).toEqual(["x86_64"]);
    expect(s.hosts).toEqual(["ctx-host-a", "ctx-host-b"]);
    expect(s.users).toEqual(["omria"]);
    expect(s.gitBranches).toEqual(["feat/d160"]);
    expect(s.gitRepos).toEqual(["flightdeck"]);
    expect(s.orchestrations).toEqual(["k8s"]);
    expect(s.pythonVersions).toEqual(["3.12.4"]);
    expect(s.processNames).toEqual(["sensor"]);
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

  it("round-trips a runtime-context-populated state through parse → build → parse", () => {
    // Locks the 9 new runtime-context facet params into the
    // round-trip contract: any future regression that drops a
    // dim from ``parseEventsUrlState`` or ``buildEventsUrlParams``
    // surfaces here as a failed equality.
    const sp = new URLSearchParams();
    sp.append("os", "Linux");
    sp.append("os", "Darwin");
    sp.append("arch", "x86_64");
    sp.append("host", "ctx-host-a");
    sp.append("user", "omria");
    sp.append("git_branch", "main");
    sp.append("git_repo", "flightdeck");
    sp.append("orchestration", "docker-compose");
    sp.append("python_version", "3.12.4");
    sp.append("process_name", "sensor");

    const parsed = parseEventsUrlState(sp);
    const rebuilt = parseEventsUrlState(buildEventsUrlParams(parsed));
    expect(rebuilt).toEqual(parsed);
    // Sanity — the rebuilt URL serialises the 9 new params under
    // their public query-string names (not the camelCase state
    // field names).
    const built = buildEventsUrlParams(parsed);
    expect(built.getAll("os")).toEqual(["Linux", "Darwin"]);
    expect(built.getAll("host")).toEqual(["ctx-host-a"]);
    expect(built.getAll("git_branch")).toEqual(["main"]);
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
