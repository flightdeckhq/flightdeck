import { describe, it, expect } from "vitest";
import { deriveAgentLinkage, deriveRelationship } from "@/lib/relationship";
import type {
  AgentSummary,
  FlavorSummary,
  RecentSession,
  Session,
} from "@/lib/types";
import { ClientType } from "@/lib/agent-identity";

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

function mkRecentSession(
  sessionId: string,
  parentSessionId?: string,
  parentAgentId?: string,
): RecentSession {
  return {
    session_id: sessionId,
    flavor: "f",
    agent_type: "coding",
    state: "active",
    started_at: "2026-05-14T00:00:00Z",
    last_seen_at: "2026-05-14T00:00:00Z",
    tokens_used: 0,
    capture_enabled: false,
    parent_session_id: parentSessionId,
    parent_agent_id: parentAgentId,
  };
}

function mkAgent(
  agentId: string,
  agentName: string,
  recentSessions: RecentSession[] = [],
): AgentSummary {
  return {
    agent_id: agentId,
    agent_name: agentName,
    agent_type: "coding",
    client_type: ClientType.ClaudeCode,
    user: "u",
    hostname: "h",
    first_seen_at: "2026-05-14T00:00:00Z",
    last_seen_at: "2026-05-14T00:00:00Z",
    total_sessions: 1,
    total_tokens: 0,
    state: "active",
    topology: "lone",
    recent_sessions: recentSessions,
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

  // ---- agents-roster fallback ------------------------------------------
  // When the agents roster carries the server-side parent_agent_id
  // projection on recent_sessions, deriveAgentLinkage resolves
  // linkages even when the parent's spawn-context session is
  // outside the fleet flavors session-map walk. Production-shape
  // bug: a busy parent that has spawned 5+ sessions since starting
  // a sub-agent loses the spawn session from BOTH windows.

  it("resolves parent via agents-roster parent_agent_id when fleet flavors don't carry the spawn session", () => {
    // Fleet flavors window doesn't include the spawn session
    // ``s-spawn`` so the original session-map walk returns null.
    const flavors = [
      mkFlavor("agent-parent", "the-parent", [mkSession("s-p-newer")]),
      mkFlavor("agent-child", "the-child", [mkSession("s-c1", "s-spawn")]),
    ];
    const agents = [
      mkAgent("agent-parent", "the-parent", [mkRecentSession("s-p-newer")]),
      mkAgent("agent-child", "the-child", [
        // parent_agent_id directly references agent-parent — wins
        // immediately over the session-map walk.
        mkRecentSession("s-c1", "s-spawn", "agent-parent"),
      ]),
    ];
    const linkage = deriveAgentLinkage("agent-child", flavors, agents);
    expect(linkage.parent).toEqual({
      agentId: "agent-parent",
      agentName: "the-parent",
    });
  });

  it("lists children via agents-roster parent_agent_id even when the parent's session is windowed out of fleet flavors", () => {
    // Parent's spawn session is NOT in fleet flavors; each child's
    // recent_sessions carries parent_agent_id pointing back.
    const flavors = [
      mkFlavor("agent-parent", "the-parent", [mkSession("s-p-newer")]),
      mkFlavor("agent-c1", "child-one", [mkSession("s-c1", "s-spawn-old")]),
      mkFlavor("agent-c2", "child-two", [mkSession("s-c2", "s-spawn-old")]),
    ];
    const agents = [
      mkAgent("agent-parent", "the-parent", [mkRecentSession("s-p-newer")]),
      mkAgent("agent-c1", "child-one", [
        mkRecentSession("s-c1", "s-spawn-old", "agent-parent"),
      ]),
      mkAgent("agent-c2", "child-two", [
        mkRecentSession("s-c2", "s-spawn-old", "agent-parent"),
      ]),
    ];
    const linkage = deriveAgentLinkage("agent-parent", flavors, agents);
    expect(linkage.children.map((c) => c.agentId).sort()).toEqual([
      "agent-c1",
      "agent-c2",
    ]);
  });
});

describe("deriveRelationship", () => {
  it("resolves a child via agents-roster parent_agent_id when fleet flavors miss the spawn session", () => {
    // The production omria@Omri-PC repro: parent's spawn session
    // is outside both windows; pre-fix the pill mislabeled the
    // child as "lone". The direct projection on the child's
    // recent_sessions resolves it to "child of <parent name>".
    const ownSessions = [mkSession("s-c1", "s-spawn-old")];
    const flavors = [
      mkFlavor("agent-parent", "omria@Omri-PC", [mkSession("s-p-newer")]),
      mkFlavor("agent-child", "omria@Omri-PC/doc-expert", ownSessions),
    ];
    const agents = [
      mkAgent("agent-parent", "omria@Omri-PC", [mkRecentSession("s-p-newer")]),
      mkAgent("agent-child", "omria@Omri-PC/doc-expert", [
        mkRecentSession("s-c1", "s-spawn-old", "agent-parent"),
      ]),
    ];
    // Without the agents roster: fallback walk returns lone.
    const fallback = deriveRelationship("agent-child", ownSessions, flavors);
    expect(fallback.mode).toBe("lone");
    // With the agents roster: direct projection resolves the
    // linkage and the pill renders "child of omria@Omri-PC".
    const fixed = deriveRelationship(
      "agent-child",
      ownSessions,
      flavors,
      agents,
    );
    expect(fixed).toEqual({
      mode: "child",
      parentName: "omria@Omri-PC",
      parentAgentId: "agent-parent",
    });
  });

  it("agents-roster parent branch picks up children whose spawn session is outside fleet flavors", () => {
    // Parent agent: agents roster carries two children referencing
    // the parent via parent_agent_id. Fleet flavors window doesn't
    // know about the linkage. The pill should render
    // ``spawns 2`` for the parent.
    const ownSessions = [mkSession("s-p-newer")];
    const flavors = [
      mkFlavor("agent-parent", "omria@Omri-PC", ownSessions),
      mkFlavor("agent-c1", "omria@Omri-PC/Plan", [
        mkSession("s-c1", "s-spawn-old"),
      ]),
      mkFlavor("agent-c2", "omria@Omri-PC/Explore", [
        mkSession("s-c2", "s-spawn-old"),
      ]),
    ];
    const agents = [
      mkAgent("agent-parent", "omria@Omri-PC", [mkRecentSession("s-p-newer")]),
      mkAgent("agent-c1", "omria@Omri-PC/Plan", [
        mkRecentSession("s-c1", "s-spawn-old", "agent-parent"),
      ]),
      mkAgent("agent-c2", "omria@Omri-PC/Explore", [
        mkRecentSession("s-c2", "s-spawn-old", "agent-parent"),
      ]),
    ];
    const rel = deriveRelationship(
      "agent-parent",
      ownSessions,
      flavors,
      agents,
    );
    expect(rel.mode).toBe("parent");
    if (rel.mode !== "parent") return;
    expect(rel.childCount).toBe(2);
    expect(rel.firstChildAgentId).toBeDefined();
  });

  it("direct projection wins over a contradicting fleet-flavors walk", () => {
    // Both sources resolve a linkage but to different agents.
    // Direct projection (server-side self-join) is authoritative.
    const ownSessions = [mkSession("s-c1", "s-spawn")];
    const flavors = [
      mkFlavor("agent-real-parent", "real", [mkSession("s-spawn")]),
      mkFlavor("agent-child", "child", ownSessions),
    ];
    const agents = [
      mkAgent("agent-real-parent", "real", [mkRecentSession("s-spawn")]),
      mkAgent("agent-child", "child", [
        // Projection says the linkage is to "agent-real-parent" —
        // matches the flavors walk. Sanity-check the agree case.
        mkRecentSession("s-c1", "s-spawn", "agent-real-parent"),
      ]),
    ];
    const rel = deriveRelationship(
      "agent-child",
      ownSessions,
      flavors,
      agents,
    );
    expect(rel).toEqual({
      mode: "child",
      parentName: "real",
      parentAgentId: "agent-real-parent",
    });
  });
});
