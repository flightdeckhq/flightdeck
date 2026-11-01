#!/usr/bin/env node
// Records the plugin's contract fixtures from a real Claude Code: runs a
// few `claude -p` scenarios with only the hook-recorder plugin loaded,
// then writes, with machine paths scrubbed,
//
//   plugin/tests/fixtures/claude-code-<version>/hooks.jsonl
//   plugin/tests/fixtures/claude-code-<version>/transcripts/<session>.jsonl
//   plugin/tests/fixtures/claude-code-<version>/transcripts/<session>/subagents/*
//
// Each scenario makes real model calls on whatever login the CLI picks,
// so run it by hand when Claude Code changes, never in CI:
//
//   node plugin/tests/tools/hook-recorder/record-scenarios.mjs
//
// Unset ANTHROPIC_API_KEY first to record on a Claude login. User
// settings are not loaded (`--setting-sources project`), so no plugin of
// yours runs beside the recorder. FD_RECORD_PYTHON names a Python with
// the `mcp` package for the MCP scenario (default: python3).
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RECORDER = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(RECORDER, "..", "..", "..", "..");
const FIXTURES = join(REPO, "plugin", "tests", "fixtures");
// The transcript records the plugin reads. Claude Code also writes
// records of the request it sent (the tools on offer, the user's
// connectors, account context); those never go into a fixture.
const TRANSCRIPT_TYPES = new Set(["user", "assistant"]);

/** A transcript with only the records the plugin reads, scrubbed. */
function fixtureTranscript(text, scrub) {
  const kept = text
    .split("\n")
    .filter((line) => {
      if (!line) return false;
      try {
        return TRANSCRIPT_TYPES.has(JSON.parse(line).type);
      } catch {
        return false;
      }
    });
  return scrub(kept.join("\n") + "\n");
}

// The scrubbed stand-ins for this machine's paths.
const FAKE_HOME = "/home/user";
const FAKE_PROJECT = "/home/user/project";
const FAKE_RECORDER = "/home/user/.claude/plugins/cache/fd-hook-recorder";
// A scenario is a few model turns; this bounds a stuck one.
const SCENARIO_TIMEOUT_MS = 240_000;
const MODEL = "claude-haiku-4-5";

const python = process.env.FD_RECORD_PYTHON || "python3";

const SCENARIOS = [
  {
    name: "bash failure and success",
    prompt:
      "Run `ls /fd-probe-does-not-exist` with the Bash tool (it fails), then run `echo recorded` with Bash. Reply with one word.",
    args: ["--allowedTools", "Bash(ls:*)", "Bash(echo:*)"],
  },
  {
    name: "MCP tool call",
    prompt: "Call the echo tool of the flightdeck-mcp-reference MCP server with the text hi. Reply with one word.",
    args: (dir) => ["--mcp-config", join(dir, "mcp.json"), "--allowedTools", "mcp__flightdeck-mcp-reference__echo"],
    setup: (dir) =>
      writeFileSync(
        join(dir, "mcp.json"),
        JSON.stringify({
          mcpServers: {
            "flightdeck-mcp-reference": {
              command: python,
              args: ["-m", "playground._mcp_reference_server"],
              env: { PYTHONPATH: REPO },
            },
          },
        }),
      ),
  },
  {
    name: "sub-agent",
    prompt:
      "Use the Agent tool to start a general-purpose sub-agent whose only job is to run `echo from-child` with the Bash tool and report the output. Then reply with one word.",
    args: ["--allowedTools", "Agent", "Bash(echo:*)"],
  },
  {
    name: "slash command",
    prompt: "/fdprobe",
    args: ["--allowedTools", "Bash(echo:*)"],
    setup: (dir) => {
      mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
      writeFileSync(
        join(dir, ".claude", "commands", "fdprobe.md"),
        "Run `echo from-command` with the Bash tool, then reply with one word.\n",
      );
    },
  },
];

function claudeVersion() {
  const out = spawnSync("claude", ["--version"], { encoding: "utf8" });
  const match = /^(\d+\.\d+\.\d+)/.exec(out.stdout || "");
  if (!match) throw new Error(`cannot read the claude version: ${out.stderr || out.stdout}`);
  return match[1];
}

function projectSlug(path) {
  return path.replace(/[^A-Za-z0-9]/g, "-");
}

/** Replace this machine's paths with the scrubbed stand-ins. */
function scrubber(projectDir) {
  const pairs = [
    // Claude Code names a project's transcript directory after its path.
    [projectSlug(projectDir), projectSlug(FAKE_PROJECT)],
    [projectDir, FAKE_PROJECT],
    [RECORDER, FAKE_RECORDER],
    [REPO, `${FAKE_HOME}/flightdeck`],
    [homedir(), FAKE_HOME],
  ].sort((a, b) => b[0].length - a[0].length);
  return (text) => pairs.reduce((acc, [from, to]) => acc.split(from).join(to), text);
}

function runScenario(scenario, recordFile, dir) {
  scenario.setup?.(dir);
  const args = typeof scenario.args === "function" ? scenario.args(dir) : scenario.args;
  const env = { ...process.env, FD_HOOK_RECORD: recordFile };
  for (const key of Object.keys(env)) {
    if (key.startsWith("FLIGHTDECK_") || key === "CLAUDECODE" || key.startsWith("CLAUDE_CODE_")) delete env[key];
  }
  const run = spawnSync(
    "claude",
    ["-p", scenario.prompt, "--model", MODEL, "--plugin-dir", RECORDER, "--setting-sources", "project", ...args],
    { cwd: dir, env, encoding: "utf8", timeout: SCENARIO_TIMEOUT_MS },
  );
  if (run.status !== 0) {
    throw new Error(`scenario "${scenario.name}" failed (${run.status}): ${run.stderr || run.stdout}`);
  }
}

function main() {
  const version = claudeVersion();
  const outDir = join(FIXTURES, `claude-code-${version}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "transcripts"), { recursive: true });
  const lines = [];
  for (const scenario of SCENARIOS) {
    const outTmp = mkdtempSync(join(tmpdir(), "fd-record-out-"));
    try {
      recordScenario(scenario, join(outTmp, "hooks.jsonl"), outDir, lines);
    } finally {
      // The raw records are not scrubbed; only the fixture is kept.
      rmSync(outTmp, { recursive: true, force: true });
    }
  }
  writeFileSync(join(outDir, "hooks.jsonl"), lines.join("\n") + "\n");
  console.log(`wrote ${outDir}`);
}

function recordScenario(scenario, recordFile, outDir, lines) {
  const dir = mkdtempSync(join(tmpdir(), "fd-record-"));
  try {
    runScenario(scenario, recordFile, dir);
    const scrub = scrubber(dir);
    const records = readFileSync(recordFile, "utf8").trim().split("\n").filter(Boolean);
    const transcripts = new Set();
    for (const line of records) {
      const rec = JSON.parse(line);
      if (typeof rec.input?.transcript_path === "string") transcripts.add(rec.input.transcript_path);
      lines.push(scrub(line));
    }
    for (const path of transcripts) {
      if (!existsSync(path)) continue;
      const name = path.split("/").pop();
      writeFileSync(join(outDir, "transcripts", name), fixtureTranscript(readFileSync(path, "utf8"), scrub));
      // Sub-agent transcripts sit beside the parent's, in <session>/subagents.
      const sub = path.replace(/\.jsonl$/, "");
      if (existsSync(sub) && statSync(sub).isDirectory()) {
        const target = join(outDir, "transcripts", name.replace(/\.jsonl$/, ""));
        cpSync(sub, target, { recursive: true });
        for (const file of walk(target)) {
          const text = readFileSync(file, "utf8");
          writeFileSync(file, file.endsWith(".jsonl") ? fixtureTranscript(text, scrub) : scrub(text));
        }
      }
    }
    console.log(`recorded: ${scenario.name} (${records.length} hooks)`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

main();
