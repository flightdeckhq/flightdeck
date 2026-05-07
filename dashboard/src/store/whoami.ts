// D147: zustand slice tracking the authenticated bearer's role.
// The dashboard calls fetchWhoami() once at App mount; the result
// drives mutation-CTA gating in MCPPolicyHeader / MCPPolicyEntryTable
// / MCPPolicyTemplatesPanel. Components consume the store directly
// — no hook abstraction; three call sites is too few to justify
// indirection.

import { create } from "zustand";

import { fetchWhoami } from "@/lib/api";

export type Role = "admin" | "viewer";

interface WhoamiState {
  /** ``null`` until fetchWhoami has resolved; mutation buttons render
   *  disabled-with-"Loading…"-tooltip while in this state to prevent
   *  the brief enabled flash a viewer would otherwise see (D147). */
  role: Role | null;
  tokenId: string | null;
  loading: boolean;
  error: string | null;
  /** Fetches /v1/whoami. Idempotent under concurrent calls — a
   *  second call while the first is in flight is a no-op. */
  fetchWhoami: () => Promise<void>;
  /** Resets to pre-fetch state. Called by Settings page when token
   *  changes (Phase 5 Part 2 wires this in; v0.6 has no caller —
   *  operators who change tokens via DevTools naturally reload, and
   *  the on-mount fetch picks up the new token). */
  reset: () => void;
}

export const useWhoamiStore = create<WhoamiState>((set, get) => ({
  role: null,
  tokenId: null,
  loading: false,
  error: null,
  async fetchWhoami() {
    if (get().loading) return; // in-flight guard
    set({ loading: true, error: null });
    try {
      const res = await fetchWhoami();
      set({
        role: res.role,
        tokenId: res.token_id,
        loading: false,
        error: null,
      });
    } catch (err) {
      set({
        role: null,
        tokenId: null,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
  reset() {
    set({ role: null, tokenId: null, loading: false, error: null });
  },
}));
