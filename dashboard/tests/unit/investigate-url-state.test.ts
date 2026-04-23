import { describe, it, expect } from "vitest";
import { parseUrlState, buildUrlParams } from "@/pages/Investigate";

// One round-trip test per facet (15) plus git_commit (16 total). The
// invariant checked is:
//
//     buildUrlParams(parseUrlState(sp)).toString()
//   == [canonicalised sp].toString()
//
// URL values survive a reload (parse -> state -> rebuild) without
// loss. Every filter key the server accepts has a mirror here so a
// deep-link from a user's browser reopens exactly the same filter
// set. Non-default values only -- ``from``, ``to``, ``sort``, ``order``
// defaults are intentionally absent from the round-trip so URLs stay
// short.

function roundTrip(qs: string): string {
  const sp = new URLSearchParams(qs);
  const state = parseUrlState(sp);
  const rebuilt = buildUrlParams(state);
  // Sort param keys for a stable comparison independent of iteration
  // order; URLSearchParams does not sort on its own.
  const sorted = new URLSearchParams();
  const pairs: Array<[string, string]> = [];
  rebuilt.forEach((v, k) => pairs.push([k, v]));
  pairs.sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of pairs) sorted.append(k, v);
  return sorted.toString();
}

function canonical(pairs: Array<[string, string]>): string {
  // from / to default to now-7d / now respectively -- the test fixtures
  // pin them to explicit values so the rebuild captures them too.
  const expected = new URLSearchParams();
  const sorted = [...pairs].sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of sorted) expected.append(k, v);
  return expected.toString();
}

describe("Investigate URL round-trip", () => {
  // Every facet + git_commit. Each test sets one filter, parses, and
  // asserts the rebuilt query string is the canonical form.

  it("state survives reload", () => {
    const input = "state=active&state=idle&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["from", "2026-04-01T00:00:00.000Z"],
        ["to", "2026-04-02T00:00:00.000Z"],
        ["state", "active"],
        ["state", "idle"],
      ]),
    );
  });

  it("flavor survives reload", () => {
    const input = "flavor=claude-code&flavor=research-agent&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["from", "2026-04-01T00:00:00.000Z"],
        ["to", "2026-04-02T00:00:00.000Z"],
        ["flavor", "claude-code"],
        ["flavor", "research-agent"],
      ]),
    );
  });

  it("agent_type survives reload", () => {
    const input = "agent_type=coding&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["agent_type", "coding"],
        ["from", "2026-04-01T00:00:00.000Z"],
        ["to", "2026-04-02T00:00:00.000Z"],
      ]),
    );
  });

  it("agent_id survives reload", () => {
    const aid = "11111111-1111-4111-8111-111111111111";
    const input = `agent_id=${aid}&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z`;
    expect(roundTrip(input)).toBe(
      canonical([
        ["agent_id", aid],
        ["from", "2026-04-01T00:00:00.000Z"],
        ["to", "2026-04-02T00:00:00.000Z"],
      ]),
    );
  });

  it("model survives reload", () => {
    const input = "model=claude-sonnet-4-6&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["from", "2026-04-01T00:00:00.000Z"],
        ["model", "claude-sonnet-4-6"],
        ["to", "2026-04-02T00:00:00.000Z"],
      ]),
    );
  });

  it("framework survives reload", () => {
    const input = "framework=claude-code&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["framework", "claude-code"],
        ["from", "2026-04-01T00:00:00.000Z"],
        ["to", "2026-04-02T00:00:00.000Z"],
      ]),
    );
  });

  // Scalar context facets (10). Single-value + multi-value paths.

  it("os multi-select survives reload", () => {
    const input = "os=Linux&os=Darwin&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["from", "2026-04-01T00:00:00.000Z"],
        ["os", "Linux"],
        ["os", "Darwin"],
        ["to", "2026-04-02T00:00:00.000Z"],
      ]),
    );
  });

  it("arch survives reload", () => {
    const input = "arch=x64&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["arch", "x64"],
        ["from", "2026-04-01T00:00:00.000Z"],
        ["to", "2026-04-02T00:00:00.000Z"],
      ]),
    );
  });

  it("hostname survives reload", () => {
    const input = "hostname=omri-pc&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["from", "2026-04-01T00:00:00.000Z"],
        ["hostname", "omri-pc"],
        ["to", "2026-04-02T00:00:00.000Z"],
      ]),
    );
  });

  it("user survives reload", () => {
    const input = "user=omria&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["from", "2026-04-01T00:00:00.000Z"],
        ["to", "2026-04-02T00:00:00.000Z"],
        ["user", "omria"],
      ]),
    );
  });

  it("process_name survives reload", () => {
    const input = "process_name=claude-code&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["from", "2026-04-01T00:00:00.000Z"],
        ["process_name", "claude-code"],
        ["to", "2026-04-02T00:00:00.000Z"],
      ]),
    );
  });

  it("node_version survives reload", () => {
    const input = "node_version=v24.15.0&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["from", "2026-04-01T00:00:00.000Z"],
        ["node_version", "v24.15.0"],
        ["to", "2026-04-02T00:00:00.000Z"],
      ]),
    );
  });

  it("python_version survives reload", () => {
    const input = "python_version=3.12.1&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["from", "2026-04-01T00:00:00.000Z"],
        ["python_version", "3.12.1"],
        ["to", "2026-04-02T00:00:00.000Z"],
      ]),
    );
  });

  it("git_branch survives reload", () => {
    const input = "git_branch=feat%2Fphase-5&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["from", "2026-04-01T00:00:00.000Z"],
        ["git_branch", "feat/phase-5"],
        ["to", "2026-04-02T00:00:00.000Z"],
      ]),
    );
  });

  it("git_commit (filter-only, no facet) survives reload", () => {
    const input = "git_commit=abc1234&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["from", "2026-04-01T00:00:00.000Z"],
        ["git_commit", "abc1234"],
        ["to", "2026-04-02T00:00:00.000Z"],
      ]),
    );
  });

  it("git_repo survives reload", () => {
    const input = "git_repo=flightdeck&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["from", "2026-04-01T00:00:00.000Z"],
        ["git_repo", "flightdeck"],
        ["to", "2026-04-02T00:00:00.000Z"],
      ]),
    );
  });

  it("orchestration survives reload", () => {
    const input = "orchestration=kubernetes&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["from", "2026-04-01T00:00:00.000Z"],
        ["orchestration", "kubernetes"],
        ["to", "2026-04-02T00:00:00.000Z"],
      ]),
    );
  });

  it("multiple filters compose without loss", () => {
    // Deep-link shape: a user pastes a URL with several facets set.
    // All of them should survive verbatim through a parse->rebuild.
    const input =
      "state=active&flavor=claude-code&user=omria&os=Linux&git_branch=main&git_commit=abc1234&from=2026-04-01T00:00:00.000Z&to=2026-04-02T00:00:00.000Z";
    expect(roundTrip(input)).toBe(
      canonical([
        ["flavor", "claude-code"],
        ["from", "2026-04-01T00:00:00.000Z"],
        ["git_branch", "main"],
        ["git_commit", "abc1234"],
        ["os", "Linux"],
        ["state", "active"],
        ["to", "2026-04-02T00:00:00.000Z"],
        ["user", "omria"],
      ]),
    );
  });
});
