// D139: tests for plugin/hooks/scripts/remembered_decisions.mjs.
//
// Covers per-token file-path derivation, atomic write/read, idempotent
// dedup on repeat writes, lookup by fingerprint, and tolerance of
// missing or corrupted files (the hook must never crash on read
// failure).

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  lookupRemembered,
  readRememberedDecisions,
  rememberedFilePath,
  writeRememberedDecision,
} from "../hooks/scripts/remembered_decisions.mjs";

// ----- HOME isolation --------------------------------------------
//
// rememberedFilePath() roots at homedir(); we override $HOME to a
// scratch directory so concurrent test runs and developer state
// don't collide.

let scratchHome;
let savedHome;
let savedUserprofile;

before(() => {
  scratchHome = mkdtempSync(join(tmpdir(), "fdrem-test-"));
  savedHome = process.env.HOME;
  savedUserprofile = process.env.USERPROFILE;
  process.env.HOME = scratchHome;
  // Node's os.homedir() reads HOME on POSIX and USERPROFILE on
  // Windows. Setting both keeps tests cross-platform.
  process.env.USERPROFILE = scratchHome;
});

after(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedUserprofile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = savedUserprofile;
  rmSync(scratchHome, { recursive: true, force: true });
});

// Wipe the scratch HOME between tests so a write in one test doesn't
// leak into the next.
beforeEach(() => {
  // Best-effort: the scratch dir might not have the file yet on
  // first test, so suppress missing-file errors.
  try {
    rmSync(join(scratchHome, ".claude"), { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ----- rememberedFilePath ----------------------------------------

describe("rememberedFilePath", () => {
  it("includes 16-char SHA-256 hex prefix of the token", () => {
    const path = rememberedFilePath("tok_test_12345");
    assert.match(
      path,
      /remembered_mcp_decisions-[0-9a-f]{16}\.json$/,
    );
  });

  it("two tokens produce distinct paths", () => {
    const a = rememberedFilePath("tok_alice");
    const b = rememberedFilePath("tok_bob");
    assert.notEqual(a, b);
  });

  it("same token produces stable path across calls", () => {
    const a = rememberedFilePath("tok_stable");
    const b = rememberedFilePath("tok_stable");
    assert.equal(a, b);
  });

  it("path lives under ~/.claude/flightdeck/", () => {
    const path = rememberedFilePath("tok_x");
    assert.match(path, /\.claude[\\/]flightdeck[\\/]remembered_mcp_decisions-/);
  });
});

// ----- readRememberedDecisions -----------------------------------

describe("readRememberedDecisions", () => {
  it("missing file returns empty list", () => {
    const result = readRememberedDecisions("tok_missing");
    assert.deepEqual(result, { version: 1, decisions: [] });
  });

  it("corrupted file returns empty list (no crash)", () => {
    const path = rememberedFilePath("tok_corrupt");
    // Manually write garbage AFTER ensuring parent dir exists by
    // doing a successful write first.
    writeRememberedDecision("tok_corrupt", {
      fingerprint: "x",
      serverUrlCanonical: "https://x",
      serverName: "x",
      decidedAt: "2026-01-01T00:00:00Z",
    });
    writeFileSync(path, "{not valid json", "utf8");
    const result = readRememberedDecisions("tok_corrupt");
    assert.deepEqual(result, { version: 1, decisions: [] });
  });

  it("file with non-array decisions returns empty list", () => {
    const path = rememberedFilePath("tok_bad_shape");
    // Same parent-dir-creation trick.
    writeRememberedDecision("tok_bad_shape", {
      fingerprint: "x",
      serverUrlCanonical: "https://x",
      serverName: "x",
      decidedAt: "2026-01-01T00:00:00Z",
    });
    writeFileSync(path, JSON.stringify({ version: 1, decisions: "wat" }));
    const result = readRememberedDecisions("tok_bad_shape");
    assert.deepEqual(result, { version: 1, decisions: [] });
  });
});

// ----- writeRememberedDecision -----------------------------------

describe("writeRememberedDecision", () => {
  it("creates the file on first write", () => {
    writeRememberedDecision("tok_first", {
      fingerprint: "abc1234567890abc",
      serverUrlCanonical: "https://maps.example.com",
      serverName: "maps",
      decidedAt: "2026-05-06T12:00:00Z",
    });
    const path = rememberedFilePath("tok_first");
    assert.equal(existsSync(path), true);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(parsed.version, 1);
    assert.equal(parsed.decisions.length, 1);
    assert.equal(parsed.decisions[0].fingerprint, "abc1234567890abc");
  });

  it("appends additional decisions", () => {
    writeRememberedDecision("tok_append", {
      fingerprint: "fp1",
      serverUrlCanonical: "https://a",
      serverName: "a",
      decidedAt: "2026-05-06T12:00:00Z",
    });
    writeRememberedDecision("tok_append", {
      fingerprint: "fp2",
      serverUrlCanonical: "https://b",
      serverName: "b",
      decidedAt: "2026-05-06T12:01:00Z",
    });
    const result = readRememberedDecisions("tok_append");
    assert.equal(result.decisions.length, 2);
  });

  it("idempotent on duplicate fingerprint", () => {
    const decision = {
      fingerprint: "dupfp",
      serverUrlCanonical: "https://x",
      serverName: "x",
      decidedAt: "2026-05-06T12:00:00Z",
    };
    writeRememberedDecision("tok_dup", decision);
    writeRememberedDecision("tok_dup", decision);
    writeRememberedDecision("tok_dup", decision);
    const result = readRememberedDecisions("tok_dup");
    assert.equal(result.decisions.length, 1);
  });

  it("atomic via temp-file + rename (no temp left after success)", () => {
    writeRememberedDecision("tok_atomic", {
      fingerprint: "fpatomic",
      serverUrlCanonical: "https://x",
      serverName: "x",
      decidedAt: "2026-05-06T12:00:00Z",
    });
    const path = rememberedFilePath("tok_atomic");
    const tmpPath = `${path}.tmp.${process.pid}`;
    assert.equal(existsSync(tmpPath), false);
  });

  it("creates parent directory when it does not exist", () => {
    const sid = "tok_mkparent";
    rmSync(join(scratchHome, ".claude"), { recursive: true, force: true });
    writeRememberedDecision(sid, {
      fingerprint: "fpmk",
      serverUrlCanonical: "https://x",
      serverName: "x",
      decidedAt: "2026-05-06T12:00:00Z",
    });
    assert.equal(existsSync(rememberedFilePath(sid)), true);
  });
});

// ----- lookupRemembered ------------------------------------------

describe("lookupRemembered", () => {
  it("returns the decision record on hit", () => {
    writeRememberedDecision("tok_hit", {
      fingerprint: "lookupfp",
      serverUrlCanonical: "https://x",
      serverName: "x",
      decidedAt: "2026-05-06T12:00:00Z",
    });
    const found = lookupRemembered("tok_hit", "lookupfp");
    assert.notEqual(found, null);
    assert.equal(found.server_name, "x");
  });

  it("returns null on miss", () => {
    writeRememberedDecision("tok_miss", {
      fingerprint: "fpa",
      serverUrlCanonical: "https://a",
      serverName: "a",
      decidedAt: "2026-05-06T12:00:00Z",
    });
    assert.equal(lookupRemembered("tok_miss", "no-such-fp"), null);
  });

  it("returns null when no file exists", () => {
    assert.equal(lookupRemembered("tok_blank", "any"), null);
  });
});

// ----- Per-token isolation ---------------------------------------

describe("per-token isolation (D139)", () => {
  it("two tokens have independent decision lists", () => {
    writeRememberedDecision("tok_alice", {
      fingerprint: "fp_alice",
      serverUrlCanonical: "https://alice",
      serverName: "alice-server",
      decidedAt: "2026-05-06T12:00:00Z",
    });
    writeRememberedDecision("tok_bob", {
      fingerprint: "fp_bob",
      serverUrlCanonical: "https://bob",
      serverName: "bob-server",
      decidedAt: "2026-05-06T12:00:00Z",
    });

    const aliceList = readRememberedDecisions("tok_alice");
    const bobList = readRememberedDecisions("tok_bob");

    assert.equal(aliceList.decisions.length, 1);
    assert.equal(bobList.decisions.length, 1);
    assert.equal(aliceList.decisions[0].fingerprint, "fp_alice");
    assert.equal(bobList.decisions[0].fingerprint, "fp_bob");

    // alice's lookup must NOT see bob's fingerprint and vice versa.
    assert.equal(lookupRemembered("tok_alice", "fp_bob"), null);
    assert.equal(lookupRemembered("tok_bob", "fp_alice"), null);
  });
});
