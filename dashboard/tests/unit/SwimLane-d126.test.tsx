import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import type { FlavorSummary, Session } from "@/lib/types";
import {
  deriveRelationship,
  scrollToAgentRow,
} from "@/lib/relationship";
import {
  SubAgentLostDot,
} from "@/components/facets/SubAgentRolePill";
import {
  RelationshipPill,
} from "@/components/facets/RelationshipPill";

// D126 § 7.fix.M — SwimLane D126 surface tests. The deriveRelationship
// helper is the load-bearing piece; rendering tests on the full
// SwimLane mount need the d3-scale + fleet store + IntersectionObserver
// shim, which is why we exercise the pure helper + the leaf
// components separately. The final "click pill navigates" contract
// lives in the e2e suite under a real DOM.

function mkSession(id: string, parentId?: string): Session {
  return {
    session_id: id,
    flavor: "x",
    agent_type: "production",
    host: null,
    framework: null,
    model: null,
    state: "closed",
    started_at: "",
    last_seen_at: "",
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    parent_session_id: parentId,
  };
}

function mkFlavor(
  agentId: string,
  agentName: string,
  sessions: Session[],
): FlavorSummary {
  return {
    flavor: agentId,
    agent_type: "production",
    session_count: sessions.length,
    active_count: 0,
    tokens_used_total: 0,
    sessions,
    agent_id: agentId,
    agent_name: agentName,
  };
}

describe("deriveRelationship — child mode", () => {
  it("returns child mode with the parent's name when our session points at it", () => {
    const flavors: FlavorSummary[] = [
      mkFlavor("parent", "parent-agent", [mkSession("p-1")]),
      mkFlavor("child", "child-agent", [mkSession("c-1", "p-1")]),
    ];
    const ours = flavors.find((f) => f.flavor === "child")!;
    const result = deriveRelationship("child", ours.sessions, flavors);
    expect(result.mode).toBe("child");
    if (result.mode !== "child") return;
    expect(result.parentName).toBe("parent-agent");
    expect(result.parentAgentId).toBe("parent");
  });

  it("falls back to flavor when the parent agent has no agent_name", () => {
    // Legacy flavors without identity hydration (pre-v0.4.0 rows
    // or store-side hydration races) still need to render
    // something; the flavor string is the closest thing to a
    // human label.
    const flavors: FlavorSummary[] = [
      {
        flavor: "parent-flavor",
        agent_type: "production",
        session_count: 1,
        active_count: 0,
        tokens_used_total: 0,
        sessions: [mkSession("p-1")],
      },
      mkFlavor("child", "child-agent", [mkSession("c-1", "p-1")]),
    ];
    const result = deriveRelationship("child", flavors[1].sessions, flavors);
    if (result.mode !== "child") throw new Error("expected child");
    expect(result.parentName).toBe("parent-flavor");
  });
});

describe("deriveRelationship — parent mode", () => {
  it("counts distinct child agents that reference our sessions as parent", () => {
    const flavors: FlavorSummary[] = [
      mkFlavor("p", "parent", [mkSession("p-1"), mkSession("p-2")]),
      mkFlavor("c1", "child-1", [mkSession("c-1", "p-1")]),
      mkFlavor("c2", "child-2", [mkSession("c-2", "p-2")]),
    ];
    const ours = flavors.find((f) => f.flavor === "p")!;
    const result = deriveRelationship("p", ours.sessions, flavors);
    expect(result.mode).toBe("parent");
    if (result.mode !== "parent") return;
    expect(result.childCount).toBe(2);
    expect(["c1", "c2"]).toContain(result.firstChildAgentId);
  });

  it("counts the same child once even when it has multiple sessions under us", () => {
    // One child agent with two sessions under our parent — a
    // re-attached or D106-revived child. Should count as 1
    // distinct child, not 2; the pill shows fan-out, not raw
    // session count.
    const flavors: FlavorSummary[] = [
      mkFlavor("p", "parent", [mkSession("p-1")]),
      mkFlavor("c", "child", [
        mkSession("c-1", "p-1"),
        mkSession("c-2", "p-1"),
      ]),
    ];
    const result = deriveRelationship("p", flavors[0].sessions, flavors);
    if (result.mode !== "parent") throw new Error("expected parent");
    expect(result.childCount).toBe(1);
  });
});

describe("deriveRelationship — lone mode", () => {
  it("returns lone when no relationship in either direction", () => {
    const flavors: FlavorSummary[] = [
      mkFlavor("a", "a", [mkSession("a-1")]),
      mkFlavor("b", "b", [mkSession("b-1")]),
    ];
    const result = deriveRelationship("a", flavors[0].sessions, flavors);
    expect(result.mode).toBe("lone");
  });
});

describe("deriveRelationship — child wins over parent priority", () => {
  it("a depth-2 sub-agent that itself spawned grandchildren reports child", () => {
    // grandparent → middle → grandchild. We are "middle" — both a
    // child of grandparent AND a parent of grandchild. Spec:
    // child relationship wins because the upstream link is the
    // more salient view in the swimlane chrome.
    const flavors: FlavorSummary[] = [
      mkFlavor("grand", "grandparent", [mkSession("g-1")]),
      mkFlavor("middle", "middle", [mkSession("m-1", "g-1")]),
      mkFlavor("gc", "grandchild", [mkSession("gc-1", "m-1")]),
    ];
    const result = deriveRelationship("middle", flavors[1].sessions, flavors);
    expect(result.mode).toBe("child");
    if (result.mode !== "child") return;
    expect(result.parentName).toBe("grandparent");
  });
});

describe("RelationshipPill rendering", () => {
  it("child pill renders ↳ + parent name and stops click propagation", () => {
    let parentClicks = 0;
    const { getByTestId } = render(
      <div onClick={() => (parentClicks += 1)}>
        <RelationshipPill mode="child" parentName="parent-agent" />
      </div>,
    );
    const pill = getByTestId("relationship-pill");
    expect(pill.textContent).toContain("↳");
    expect(pill.textContent).toContain("parent-agent");
    expect(pill.dataset.mode).toBe("child");
    pill.click();
    // The pill stops propagation to keep an outer row click (e.g.
    // expand the swimlane) from firing on a pill click.
    expect(parentClicks).toBe(0);
  });

  it("parent pill renders → + child count", () => {
    const { getByTestId } = render(
      <RelationshipPill mode="parent" childCount={3} />,
    );
    const pill = getByTestId("relationship-pill");
    expect(pill.textContent).toContain("→");
    expect(pill.textContent).toContain("3");
    expect(pill.dataset.mode).toBe("parent");
  });

  it("invokes onClick when the pill is clicked", () => {
    let called = 0;
    const { getByTestId } = render(
      <RelationshipPill
        mode="child"
        parentName="x"
        onClick={() => (called += 1)}
      />,
    );
    getByTestId("relationship-pill").click();
    expect(called).toBe(1);
  });
});

describe("SubAgentLostDot rendering", () => {
  it("renders with the lost-state colour", () => {
    const { getByTestId } = render(<SubAgentLostDot />);
    const dot = getByTestId("sub-agent-lost-dot");
    expect(dot.style.color).toContain("--status-lost");
  });
});

describe("scrollToAgentRow (helper)", () => {
  it("invokes scrollIntoView on a matching data-agent-id node", () => {
    const node = document.createElement("div");
    node.setAttribute("data-agent-id", "abc-123");
    let called = 0;
    node.scrollIntoView = () => {
      called += 1;
    };
    document.body.appendChild(node);
    scrollToAgentRow("abc-123");
    expect(called).toBe(1);
    document.body.removeChild(node);
  });

  it("no-ops on missing target rather than throwing", () => {
    expect(() => scrollToAgentRow("not-in-dom")).not.toThrow();
  });
});
