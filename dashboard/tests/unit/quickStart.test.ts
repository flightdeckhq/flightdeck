// D146: tests for the per-scope ephemeral quick-start tracking
// store. Each scope is independent — applying on Global doesn't
// suppress the link on a flavor that still has zero entries.

import { beforeEach, describe, expect, it } from "vitest";

import { useMCPQuickStartStore } from "@/store/quickStart";

beforeEach(() => {
  useMCPQuickStartStore.getState().reset();
});

describe("useMCPQuickStartStore", () => {
  it("wasApplied returns false for an unmarked scope", () => {
    expect(useMCPQuickStartStore.getState().wasApplied("global")).toBe(false);
  });

  it("markApplied + wasApplied round-trip for a single scope", () => {
    useMCPQuickStartStore.getState().markApplied("global");
    expect(useMCPQuickStartStore.getState().wasApplied("global")).toBe(true);
  });

  it("tracks scopes independently — Global applied doesn't suppress flavor", () => {
    useMCPQuickStartStore.getState().markApplied("global");
    expect(useMCPQuickStartStore.getState().wasApplied("global")).toBe(true);
    expect(useMCPQuickStartStore.getState().wasApplied("flavor:prod")).toBe(false);
  });

  it("reset clears all marked scopes", () => {
    useMCPQuickStartStore.getState().markApplied("global");
    useMCPQuickStartStore.getState().markApplied("flavor:prod");
    useMCPQuickStartStore.getState().reset();
    expect(useMCPQuickStartStore.getState().wasApplied("global")).toBe(false);
    expect(useMCPQuickStartStore.getState().wasApplied("flavor:prod")).toBe(false);
  });

  it("markApplied on the same scope twice is idempotent", () => {
    useMCPQuickStartStore.getState().markApplied("global");
    useMCPQuickStartStore.getState().markApplied("global");
    expect(useMCPQuickStartStore.getState().wasApplied("global")).toBe(true);
  });
});
