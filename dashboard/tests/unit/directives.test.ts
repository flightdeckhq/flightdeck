import { describe, it, expect } from "vitest";
import type { Session } from "@/lib/types";
import {
  flavorHasDirectiveCapableSession,
  hasLiveCustomDirectiveSession,
  runCountLabel,
  sessionRunsCustomDirectives,
  sessionSupportsDirectives,
  stoppableSessions,
} from "@/lib/directives";

function mkSession(
  id: string,
  state: Session["state"],
  context?: Record<string, unknown>,
): Session {
  return {
    session_id: id,
    flavor: "test",
    agent_type: "production",
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

  it("falls back to the client type's registry default when the flag is absent", () => {
    // A hook-based client (observer) defaults to no directives, the
    // sensor and the Agent SDK interceptor to directives.
    expect(sessionSupportsDirectives({ ...mkSession("cx", "active"), client_type: "codex" })).toBe(false);
    expect(sessionSupportsDirectives({ ...mkSession("cc", "active"), client_type: "claude_code" })).toBe(false);
    expect(sessionSupportsDirectives({ ...mkSession("fs", "active"), client_type: "flightdeck_sensor" })).toBe(true);
    expect(sessionSupportsDirectives({ ...mkSession("sdk", "active"), client_type: "claude_agent_sdk" })).toBe(true);
  });

  it("lets an explicit flag override the client type's default", () => {
    expect(
      sessionSupportsDirectives({
        ...mkSession("cx-on", "active", { supports_directives: true }),
        client_type: "codex",
      }),
    ).toBe(true);
    expect(
      sessionSupportsDirectives({
        ...mkSession("fs-off", "active", { supports_directives: false }),
        client_type: "flightdeck_sensor",
      }),
    ).toBe(false);
  });

  it("falls through to the flavor rule for a client_type outside the registry", () => {
    // The wire value is a plain string; an unknown one takes no registry
    // default.
    const s = { ...mkSession("unknown", "active"), flavor: "claude-code", client_type: "windsurf" };
    expect(sessionSupportsDirectives(s)).toBe(false);
  });

  it("lets an explicit true flag win over a claude-code flavor", () => {
    // Only an absent flag falls back to the flavor rule.
    const s = {
      ...mkSession("cc-on", "active", { supports_directives: true }),
      flavor: "claude-code",
    };
    expect(sessionSupportsDirectives(s)).toBe(true);
  });

  it("uses the registry default, not the flavor, once client_type is known", () => {
    // A sensor session an operator named "claude-code" keeps its Stop
    // button: the flavor rule applies only to rows with no client_type.
    const s = { ...mkSession("named", "active"), flavor: "claude-code", client_type: "flightdeck_sensor" };
    expect(sessionSupportsDirectives(s)).toBe(true);
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

describe("sessionRunsCustomDirectives", () => {
  it("is true for a sensor session and for a pre-registry row outside Claude Code", () => {
    expect(
      sessionRunsCustomDirectives({ client_type: "flightdeck_sensor", flavor: "research-agent" }),
    ).toBe(true);
    expect(sessionRunsCustomDirectives({ flavor: "research-agent" })).toBe(true);
  });

  it("is false for a client that takes stop directives but runs no custom handlers", () => {
    // An enforcement-on plugin session and an Agent SDK run take Stop
    // and budgets but answer a custom directive with an error.
    const plugin = {
      client_type: "claude_code",
      flavor: "claude-code",
      context: { supports_directives: true },
    };
    expect(sessionSupportsDirectives(plugin)).toBe(true);
    expect(sessionRunsCustomDirectives(plugin)).toBe(false);
    expect(sessionRunsCustomDirectives({ client_type: "claude_agent_sdk", flavor: "sdk" })).toBe(
      false,
    );
  });

  it("is false for an observer session and for a sensor session that opted out", () => {
    expect(
      sessionRunsCustomDirectives({
        client_type: "claude_code",
        flavor: "ci",
        context: { telemetry: "otlp", supports_directives: false },
      }),
    ).toBe(false);
    expect(
      sessionRunsCustomDirectives({
        client_type: "flightdeck_sensor",
        flavor: "x",
        context: { supports_directives: false },
      }),
    ).toBe(false);
  });
});

describe("stoppableSessions", () => {
  it("keeps the live sessions that can act on a directive", () => {
    const sessions = [
      mkSession("live", "active"),
      mkSession("idle", "idle"),
      mkSession("closed", "closed"),
      mkSession("observer", "active", { supports_directives: false }),
    ];
    expect(stoppableSessions(sessions).map((s) => s.session_id)).toEqual(["live", "idle"]);
  });
});

describe("hasLiveCustomDirectiveSession", () => {
  it("needs a live session that runs custom handlers", () => {
    const sensorLive = { ...mkSession("s", "idle"), client_type: "flightdeck_sensor" as const };
    expect(hasLiveCustomDirectiveSession([sensorLive])).toBe(true);
  });

  it("is false when the only such session is no longer live", () => {
    // A directive sent from the Fleet row reaches only live runs, so a
    // closed sensor run beside a live plugin run offers nothing.
    const sensorClosed = { ...mkSession("s", "closed"), client_type: "flightdeck_sensor" as const };
    const pluginLive = {
      ...mkSession("p", "active", { supports_directives: true }),
      client_type: "claude_code" as const,
      flavor: "claude-code",
    };
    expect(hasLiveCustomDirectiveSession([sensorClosed, pluginLive])).toBe(false);
    expect(hasLiveCustomDirectiveSession([])).toBe(false);
  });
});

describe("runCountLabel", () => {
  it("names the runs a directive reached", () => {
    expect(runCountLabel(1)).toBe("1 run");
    expect(runCountLabel(3)).toBe("3 runs");
    expect(runCountLabel(0)).toBe("0 runs");
  });
});
