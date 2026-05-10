// D146: ephemeral session tracking for the MCP Protection Policy
// quick-start template link. Per-scope so applying a template on
// Global doesn't suppress the link on a flavor that still has zero
// entries.
//
// State is intentionally NOT persisted to localStorage or the
// backend. Resets on page reload — operators who want to re-surface
// the link reload the page. Per-scope dimension is orthogonal to
// the no-persistence framing.

import { create } from "zustand";

interface QuickStartState {
  /** Set of scopeKeys (e.g. "global", "flavor:production") where
   *  the operator has applied a template this page-load session. */
  appliedScopes: Set<string>;
  markApplied: (scopeKey: string) => void;
  wasApplied: (scopeKey: string) => boolean;
  reset: () => void;
}

export const useMCPQuickStartStore = create<QuickStartState>((set, get) => ({
  appliedScopes: new Set(),
  markApplied(scopeKey) {
    set((s) => {
      const next = new Set(s.appliedScopes);
      next.add(scopeKey);
      return { appliedScopes: next };
    });
  },
  wasApplied(scopeKey) {
    return get().appliedScopes.has(scopeKey);
  },
  reset() {
    set({ appliedScopes: new Set() });
  },
}));
