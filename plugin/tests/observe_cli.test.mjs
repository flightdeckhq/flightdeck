import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, "..", "hooks", "scripts", "observe_cli.mjs");

/**
 * Helper: run observe_cli.mjs as a child process, piping stdinData,
 * returning { code, stdout, stderr }.
 */
function runScript(stdinData, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT],
      {
        env: { ...process.env, ...env },
        timeout: 10000,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? error.code ?? 1 : 0,
          stdout,
          stderr,
        });
      }
    );
    if (stdinData != null) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
  });
}

/**
 * Helper: start a local HTTP server that captures POST bodies.
 * Returns { server, port, bodies() }.
 */
function startCaptureServer() {
  return new Promise((resolve) => {
    const captured = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          captured.push(JSON.parse(body));
        } catch {
          captured.push(body);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, bodies: () => captured });
    });
  });
}

describe("observe_cli.mjs", () => {
  let capture;

  before(async () => {
    capture = await startCaptureServer();
  });

  after(() => {
    capture.server.close();
  });

  it("maps PreToolUse to pre_call", async () => {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const body = capture.bodies().at(-1);
    assert.equal(body.event_type, "pre_call");
    assert.equal(body.flavor, "claude-code");
    assert.equal(body.agent_type, "developer");
    assert.equal(body.framework, "claude-code");
    assert.equal(body.tool_name, "Bash");
    assert.equal(body.has_content, false);
    assert.equal(body.content, null);
  });

  it("maps PostToolUse to tool_call with tool_name", async () => {
    const input = JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read" });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const body = capture.bodies().at(-1);
    assert.equal(body.event_type, "tool_call");
    assert.equal(body.tool_name, "Read");
    assert.equal(body.flavor, "claude-code");
    assert.equal(body.agent_type, "developer");
  });

  it("maps Stop to session_end", async () => {
    const input = JSON.stringify({ hook_event_name: "Stop" });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const body = capture.bodies().at(-1);
    assert.equal(body.event_type, "session_end");
    assert.equal(body.tool_name, null);
  });

  it("exits zero when FLIGHTDECK_SERVER is missing", async () => {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    const env = {
      FLIGHTDECK_SERVER: "",
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    assert.ok(result.stderr.includes("FLIGHTDECK_SERVER"));
  });

  it("exits zero when FLIGHTDECK_TOKEN is missing", async () => {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    const env = {
      FLIGHTDECK_SERVER: "http://localhost:9999",
      FLIGHTDECK_TOKEN: "",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    assert.ok(result.stderr.includes("FLIGHTDECK_TOKEN"));
  });

  it("exits zero on network error", async () => {
    const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" });
    // Point to a port nothing is listening on
    const env = {
      FLIGHTDECK_SERVER: "http://127.0.0.1:1",
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    assert.ok(result.stderr.includes("POST failed"));
  });

  it("exits zero on unknown hook event", async () => {
    const input = JSON.stringify({ hook_event_name: "SomeUnknownHook" });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const countBefore = capture.bodies().length;
    const result = await runScript(input, env);
    assert.equal(result.code, 0);
    // Should not have sent any request
    assert.equal(capture.bodies().length, countBefore);
  });

  it("populates tool_name from tool field fallback", async () => {
    const input = JSON.stringify({ hook_event_name: "PostToolUse", tool: "Write" });
    const env = {
      FLIGHTDECK_SERVER: `http://127.0.0.1:${capture.port}`,
      FLIGHTDECK_TOKEN: "tok_test",
    };
    const result = await runScript(input, env);
    assert.equal(result.code, 0);

    const body = capture.bodies().at(-1);
    assert.equal(body.tool_name, "Write");
  });
});
