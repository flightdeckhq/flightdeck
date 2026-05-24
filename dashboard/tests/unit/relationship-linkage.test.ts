import { describe, it, expect } from "vitest";
import { deriveAgentLinkage } from "@/lib/relationship";
import type { FlavorSummary, Session } from "@/lib/types";

function mkSession(sessionId: string, parentSessionId?: string): Session {
  return {
    session_id: sessionId,
    flavor: "f",
    agent_type: "coding",
    host: null,
    framework: null,
    model: null,
    state: "closed",
    started_at: "2026-05-14T00:00:00Z",
    last_seen_at: "2026-05-14T00:00:00Z",
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    parent_session_id: parentSessionId ?? null,
  };
}

function mkFlavor(
  agentId: string,
  agentName: string,
  sessions: Session[],
): FlavorSummary {
  return {
    flavor: agentId,
    agent_type: "coding",
    session_count: sessions.length,
    active_count: 0,
    tokens_used_total: 0,
    sessions,
    agent_id: agentId,
    agent_name: agentName,
  };
}

describe("deriveAgentLinkage", () => {
  it("returns no linkage for a lone agent", () => {
    const flavors = [mkFlavor("agent-a", "alpha", [mkSession("s-a1")])];
    const linkage = deriveAgentLinkage("agent-a", flavors);
    expect(linkage.parent).toBeNull();
    expect(linkage.children).toEqual([]);
  });

  it("resolves the parent agent for a child", () => {
    const flavors = [
      mkFlavor("agent-parent", "the-parent", [mkSession("s-p1")]),
      mkFlavor("agent-child", "the-child", [mkSession("s-c1", "s-p1")]),
    ];
    const linkage = deriveAgentLinkage("agent-child", flavors);
    expect(linkage.parent).toEqual({
      agentId: "agent-parent",
      agentName: "the-parent",
    });
    expect(linkage.children).toEqual([]);
  });

  it("lists every distinct child agent for a parent", () => {
    const flavors = [
      mkFlavor("agent-parent", "the-parent", [mkSession("s-p1")]),
      mkFlavor("agent-c1", "child-one", [
        mkSession("s-c1a", "s-p1"),
        mkSession("s-c1b", "s-p1"),
      ]),
      mkFlavor("agent-c2", "child-two", [mkSession("s-c2", "s-p1")]),
    ];
    const linkage = deriveAgentLinkage("agent-parent", flavors);
    expect(linkage.parent).toBeNull();
    expect(linkage.children).toEqual([
      { agentId: "agent-c1", agentName: "child-one" },
      { agentId: "agent-c2", agentName: "child-two" },
    ]);
  });

  it("reports both a parent and children for a mid-graph agent", () => {
    const flavors = [
      mkFlavor("agent-grand", "grand", [mkSession("s-g1")]),
      mkFlavor("agent-mid", "mid", [mkSession("s-m1", "s-g1")]),
      mkFlavor("agent-leaf", "leaf", [mkSession("s-l1", "s-m1")]),
    ];
    const linkage = deriveAgentLinkage("agent-mid", flavors);
    expect(linkage.parent).toEqual({
      agentId: "agent-grand",
      agentName: "grand",
    });
    expect(linkage.children).toEqual([
      { agentId: "agent-leaf", agentName: "leaf" },
    ]);
  });
});
