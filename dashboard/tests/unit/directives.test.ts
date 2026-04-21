import { describe, it, expect } from "vitest";
import type { Session } from "@/lib/types";
import {
  flavorHasDirectiveCapableSession,
  sessionSupportsDirectives,
} from "@/lib/directives";

function mkSession(
  id: string,
  state: Session["state"],
  context?: Record<string, unknown>,
): Session {
  return {
    session_id: id,
    flavor: "test",
    agent_type: "autonomous",
    host: null,
    framework: null,
    model: null,
    state,
    started_at: "",
    last_seen_at: "",
    ended_at: null,
    tokens_used: 0,
    token_limit: null,
    context,
  };
}

describe("sessionSupportsDirectives", () => {
  it("returns true when context is missing", () => {
    // Python sensor sessions omit the field -- every pre-existing
    // session must continue to show the kill switch.
    expect(sessionSupportsDirectives(mkSession("a", "active"))).toBe(true);
  });

  it("returns true when context has no supports_directives key", () => {
    expect(
      sessionSupportsDirectives(mkSession("b", "active", { os: "Linux" })),
    ).toBe(true);
  });

  it("returns false when context.supports_directives === false", () => {
    // Observer-only sessions (Claude Code plugin, and every future
    // hook-based plugin) set this flag. UI hides the kill switch.
    expect(
      sessionSupportsDirectives(
        mkSession("c", "active", { supports_directives: false }),
      ),
    ).toBe(false);
  });

  it("returns true when the flag is any truthy non-false value", () => {
    // Defensive: only an explicit `false` disables the button. A
    // broken sensor that emits `"false"` (string) still supports
    // directives -- we don't coerce.
    expect(
      sessionSupportsDirectives(
        mkSession("d", "active", { supports_directives: "false" }),
      ),
    ).toBe(true);
    expect(
      sessionSupportsDirectives(
        mkSession("e", "active", { supports_directives: true }),
      ),
    ).toBe(true);
  });

  it("returns false for a claude-code flavor even without the explicit flag", () => {
    // Second-line defence for pre-flag Claude Code sessions. Context
    // is set once on session_start and never updated
    // (workers/internal/writer/postgres.go: ON CONFLICT does NOT
    // touch the context column), so a session started before the
    // plugin fix keeps a context row without supports_directives
    // forever. Flavor identification keeps the kill switch hidden.
    const s = { ...mkSession("pre-flag", "active"), flavor: "claude-code" };
    expect(sessionSupportsDirectives(s)).toBe(false);
  });

  it("returns false when context.frameworks tags claude-code but flavor is renamed", () => {
    // Operator-renamed flavor with claude-code/<version> still in the
    // framework list. isClaudeCodeSession picks this up.
    const s = {
      ...mkSession("renamed", "active", {
        frameworks: ["claude-code/1.2.3"],
      }),
      flavor: "custom-rename",
    };
    expect(sessionSupportsDirectives(s)).toBe(false);
  });
});

describe("flavorHasDirectiveCapableSession", () => {
  it("returns false when every live session is observer-only", () => {
    const sessions = [
      mkSession("a", "active", { supports_directives: false }),
      mkSession("b", "idle", { supports_directives: false }),
      // Closed sessions are not "live" so their flag doesn't matter.
      mkSession("c", "closed"),
    ];
    expect(flavorHasDirectiveCapableSession(sessions)).toBe(false);
  });

  it("returns true in a mixed flavor", () => {
    // One sensor session + one claude-code session under the same
    // flavor name. The directive still reaches the sensor session,
    // so the button stays.
    const sessions = [
      mkSession("a", "active", { supports_directives: false }),
      mkSession("b", "active"),
    ];
    expect(flavorHasDirectiveCapableSession(sessions)).toBe(true);
  });

  it("returns true when every live session supports directives", () => {
    const sessions = [mkSession("a", "active"), mkSession("b", "idle")];
    expect(flavorHasDirectiveCapableSession(sessions)).toBe(true);
  });

  it("returns false for an empty flavor", () => {
    // No live sessions means nothing to stop -- FleetPanel also gates
    // on liveSessions.length > 0 separately, but the helper should
    // still be honest.
    expect(flavorHasDirectiveCapableSession([])).toBe(false);
  });

  it("returns false when the only live session is closed-state", () => {
    // Defensive: a closed sensor session is live=false and should
    // not keep the button visible.
    const sessions = [mkSession("a", "closed")];
    expect(flavorHasDirectiveCapableSession(sessions)).toBe(false);
  });
});
