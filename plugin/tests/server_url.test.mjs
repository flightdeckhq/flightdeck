// One FLIGHTDECK_SERVER value for the sensor and the plugin. The
// flightdeck binary prints its ingestion URL (http://host:4000/ingest),
// the form the Python sensor takes; the plugin builds its endpoints
// from the base URL (http://host:4000). core/config.mjs serverBaseUrl
// resolves both forms to the base, and a session whose first event the
// server does not accept tells the user so, once, through the hook's
// systemMessage. The run against the real binary is in
// cmd/flightdeck/plugin_test.go.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { describeStartFailure, resolveConfig, serverBaseUrl } from "../hooks/scripts/observe_cli.mjs";
import { assertIngestionContract, hookEnv, privateTmp, runScript } from "./contract_harness.mjs";

// [configured value, the base URL it resolves to, why the case is here]
const BASE_URL_CASES = [
  ["http://localhost:4000", "http://localhost:4000", "the plugin's default and the compose-era value"],
  ["http://localhost:4000/", "http://localhost:4000", "a trailing slash"],
  ["http://localhost:4000/ingest", "http://localhost:4000", "the ingestion URL the start-up block prints"],
  ["http://localhost:4000/ingest/", "http://localhost:4000", "the ingestion URL with a trailing slash"],
  ["http://localhost:4000/ingest///", "http://localhost:4000", "several trailing slashes"],
  ["http://127.0.0.1:4100/ingest", "http://127.0.0.1:4100", "an IP and another port"],
  ["http://[::1]:4000/ingest", "http://[::1]:4000", "an IPv6 literal"],
  ["https://flightdeck.example.com", "https://flightdeck.example.com", "a public host, base form"],
  ["https://flightdeck.example.com/ingest", "https://flightdeck.example.com", "a public host, ingestion form"],
  ["https://example.com/fd", "https://example.com/fd", "a reverse proxy's path prefix, base form"],
  ["https://example.com/fd/", "https://example.com/fd", "a path prefix with a trailing slash"],
  ["https://example.com/fd/ingest", "https://example.com/fd", "a path prefix, ingestion form"],
  ["https://example.com/fd/ingest/", "https://example.com/fd", "a path prefix, ingestion form, trailing slash"],
  ["HTTP://LocalHost:4000/ingest", "http://localhost:4000", "an upper-case scheme and host"],
  ["HTTPS://Example.COM/FD/ingest", "https://example.com/FD", "the path keeps its case"],
  ["https://example.com/myingest", "https://example.com/myingest", "a path that only ends in the letters"],
  ["https://example.com/pre-ingest", "https://example.com/pre-ingest", "the letters after a hyphen"],
  ["https://example.com/ingestion", "https://example.com/ingestion", "a longer word that starts with them"],
  ["https://example.com/Ingest", "https://example.com/Ingest", "paths are case-sensitive: not the ingestion segment"],
  ["https://example.com/ingest/v2", "https://example.com/ingest/v2", "ingest is not the last segment"],
  ["https://example.com/ingest/ingest", "https://example.com/ingest", "one segment is dropped, not two"],
  ["http://ingest.example.com", "http://ingest.example.com", "a host named ingest, base form"],
  ["http://ingest.example.com/ingest", "http://ingest.example.com", "a host named ingest, ingestion form"],
  ["http://localhost:4000/ingest?debug=1", "http://localhost:4000", "a query string after the ingestion URL"],
  ["http://localhost:4000?debug=1", "http://localhost:4000", "a query string after the base URL"],
  ["http://localhost:4000/ingest#top", "http://localhost:4000", "a fragment"],
  ["http://localhost:80/ingest", "http://localhost", "the scheme's default port is implied"],
  ["https://user:secret@example.com/ingest", "https://example.com", "credentials never reach the result"],
  ["  http://localhost:4000/ingest \n", "http://localhost:4000", "surrounding whitespace"],
  ["", "", "an empty value"],
  ["   ", "", "a blank value"],
  [undefined, "", "no value"],
  [null, "", "a null value"],
  [4000, "", "a value that is not a string"],
  ["localhost:4000", "localhost:4000", "no scheme: left for the request to refuse"],
  ["localhost:4000/ingest/", "localhost:4000", "no scheme, ingestion form: the same trimming"],
  ["ftp://example.com/ingest", "ftp://example.com", "a scheme that is not http(s)"],
  ["/ingest", "", "a bare path"],
];

describe("serverBaseUrl", () => {
  for (const [value, want, why] of BASE_URL_CASES) {
    it(`${JSON.stringify(value)} -> ${JSON.stringify(want)} (${why})`, () => {
      assert.equal(serverBaseUrl(value), want);
    });
  }

  it("gives the base and the ingestion URL of one server the same events endpoint", () => {
    for (const base of ["http://localhost:4000", "https://example.com/fd", "http://ingest.example.com"]) {
      const endpoints = [base, `${base}/`, `${base}/ingest`, `${base}/ingest/`].map(
        (value) => `${serverBaseUrl(value)}/ingest/v1/events`,
      );
      assert.deepEqual([...new Set(endpoints)], [`${base}/ingest/v1/events`]);
    }
  });
});

describe("resolveConfig server", () => {
  const quiet = { FLIGHTDECK_QUIET: "1", FLIGHTDECK_TOKEN: "tok_test" };

  it("resolves the environment's base form and ingestion form to one server", () => {
    assert.equal(resolveConfig({ ...quiet, FLIGHTDECK_SERVER: "http://fd.internal:4000" }).server, "http://fd.internal:4000");
    assert.equal(resolveConfig({ ...quiet, FLIGHTDECK_SERVER: "http://fd.internal:4000/ingest" }).server, "http://fd.internal:4000");
    assert.equal(resolveConfig({ ...quiet, FLIGHTDECK_SERVER: "http://fd.internal:4000/ingest/" }).server, "http://fd.internal:4000");
  });

  it("resolves the plugin option the same way", () => {
    assert.equal(
      resolveConfig({ ...quiet, CLAUDE_PLUGIN_OPTION_SERVER: "https://example.com/fd/ingest" }).server,
      "https://example.com/fd",
    );
  });

  it("keeps the default when nothing is configured", () => {
    assert.equal(resolveConfig(quiet).server, "http://localhost:4000");
    assert.equal(resolveConfig({ ...quiet, FLIGHTDECK_SERVER: "  " }).server, "http://localhost:4000");
  });

  it("drops credentials in the URL and still resolves the ingestion form", () => {
    assert.equal(
      resolveConfig({ ...quiet, FLIGHTDECK_SERVER: "https://user:secret@example.com/ingest" }).server,
      "https://example.com",
    );
  });
});

describe("describeStartFailure", () => {
  const failed = (status, reason) => ({ accepted: false, retryable: true, status, clockSkew: false, reason });

  it("names a wrong address and the setting to change (404 and 405)", () => {
    for (const status of [404, 405]) {
      const text = describeStartFailure("http://localhost:4000/typo", failed(status, `HTTP ${status}`));
      assert.match(text, /^Flightdeck: http:\/\/localhost:4000\/typo has no ingestion API at http:\/\/localhost:4000\/typo\/ingest\/v1\/events/);
      assert.match(text, new RegExp(`HTTP ${status}`));
      assert.match(text, /FLIGHTDECK_SERVER or the plugin's server option/);
    }
  });

  it("names a server that does not answer, with the reason", () => {
    const text = describeStartFailure("http://localhost:4000", failed(null, "ECONNREFUSED"));
    assert.match(text, /^Flightdeck: no answer from http:\/\/localhost:4000 \(ECONNREFUSED\)\./);
    assert.match(text, /Start flightdeck/);
  });

  it("names a refused token by where it is set", () => {
    for (const status of [401, 403]) {
      const text = describeStartFailure("https://example.com", failed(status, `HTTP ${status}`));
      assert.match(text, new RegExp(`refused the access token \\(HTTP ${status}\\)`));
      assert.match(text, /FLIGHTDECK_TOKEN or the plugin's token option/);
    }
  });

  it("names a value that is not an http(s) URL", () => {
    const text = describeStartFailure("localhost:4000", failed(null, "ERR_INVALID_URL"));
    assert.match(text, /the server address "localhost:4000" is not an http:\/\/ or https:\/\/ URL/);
  });

  it("names a host the server does not answer for (421) and both ways out", () => {
    const text = describeStartFailure("http://flightdeck:4000", failed(421, "HTTP 421"));
    assert.match(text, /^Flightdeck: http:\/\/flightdeck:4000 does not answer for that host name \(HTTP 421\)/);
    assert.match(text, /--allowed-hosts \(FLIGHTDECK_ALLOWED_HOSTS\)/);
  });

  it("reports any other status as it is", () => {
    const text = describeStartFailure("http://localhost:4000", failed(503, "HTTP 503"));
    assert.match(text, /answered HTTP 503 to this session's first event/);
  });

  it("never repeats credentials from the server URL or an error text", () => {
    const text = describeStartFailure(
      "https://user:hunter2@example.com",
      failed(null, "request to https://user:hunter2@example.com/ingest/v1/events failed"),
    );
    assert.doesNotMatch(text, /hunter2/);
  });

  it("says in every case that the session is not recorded", () => {
    for (const sent of [failed(null, "timeout"), failed(404, "HTTP 404"), failed(401, "HTTP 401"), failed(500, "HTTP 500")]) {
      assert.match(describeStartFailure("http://localhost:4000", sent), /Nothing from this session is recorded until the server accepts an event\.$/);
    }
  });
});

// A stand-in for a Flightdeck origin that, like the real one, serves
// the ingestion API at /ingest/v1/events and the query API under /api
// only: any other path is a 404, so an event posted to the wrong path
// cannot pass. ``answer`` overrides the status of the events route.
function startOrigin({ answer = 200 } = {}) {
  return new Promise((resolve) => {
    const requests = [];
    const events = [];
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null });
        if (req.method === "POST" && req.url === "/ingest/v1/events") {
          if (answer !== 200) {
            res.writeHead(answer, { "Content-Type": "application/json" });
            res.end('{"error":"refused"}');
            return;
          }
          events.push(JSON.parse(body));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"status":"ok","attached":false}');
          return;
        }
        if (req.method === "GET" && req.url.startsWith("/api/v1/mcp-policies/")) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end('{"error":"no policy"}');
          return;
        }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("404 page not found\n");
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests, events }));
  });
}

function sessionStartInput(cwd, source = "startup") {
  return JSON.stringify({
    hook_event_name: "SessionStart",
    session_id: `cc-${randomUUID()}`,
    cwd,
    source,
  });
}

// A token unlike anything else in the output, so finding it anywhere
// means it leaked.
const SECRET_TOKEN = "ftd_3f9c1e7a5b2d4c6e8f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f3a5b7c9d1e";

describe("the SessionStart hook and the configured server", () => {
  let origin;
  let project;
  before(async () => {
    origin = await startOrigin();
    // A project that declares an MCP server, so SessionStart also
    // fetches the MCP policy from the query API.
    project = join(privateTmp, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { files: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }),
    );
  });
  after(() => {
    origin.server.closeAllConnections?.();
    origin.server.close();
  });

  const FORMS = [
    ["the base URL", (port) => `http://127.0.0.1:${port}`],
    ["the base URL with a trailing slash", (port) => `http://127.0.0.1:${port}/`],
    ["the ingestion URL the start-up block prints", (port) => `http://127.0.0.1:${port}/ingest`],
    ["the ingestion URL with a trailing slash", (port) => `http://127.0.0.1:${port}/ingest/`],
    ["an upper-case scheme and a query string", (port) => `HTTP://127.0.0.1:${port}/ingest?x=1`],
  ];

  for (const [name, valueFor] of FORMS) {
    it(`posts a valid session_start to /ingest/v1/events given ${name}`, async () => {
      const value = valueFor(origin.port);
      const sessionId = randomUUID();
      const seen = origin.requests.length;
      const result = await runScript(
        sessionStartInput(project),
        hookEnv({}, { FLIGHTDECK_SERVER: value, FLIGHTDECK_TOKEN: SECRET_TOKEN, CLAUDE_SESSION_ID: sessionId }),
      );
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /cannot reach/, `${value}: ${result.stderr}`);
      assert.equal(result.stdout, "", "an accepted session start prints nothing");

      const start = origin.events.find((event) => event.session_id === sessionId);
      assert.ok(start, `no event for the session reached /ingest/v1/events with FLIGHTDECK_SERVER=${value}`);
      assert.equal(start.event_type, "session_start");
      // The fields the ingestion validator requires: a stub that
      // answers 200 to anything would hide a 400 from the real one.
      assertIngestionContract(start);
      assert.equal(start.client_type, "claude_code");

      const made = origin.requests.slice(seen);
      assert.deepEqual(
        made.filter((request) => request.method === "POST").map((request) => request.url),
        ["/ingest/v1/events"],
      );
      // The MCP policy is fetched from the same server's query API.
      const policyFetches = made.filter((request) => request.method === "GET").map((request) => request.url);
      assert.ok(policyFetches.length > 0, "the MCP policy was fetched");
      for (const url of policyFetches) assert.match(url, /^\/api\/v1\/mcp-policies\//);
      for (const request of made) assert.equal(request.authorization, `Bearer ${SECRET_TOKEN}`);
    });
  }
});

describe("a session start the server does not accept", () => {
  function notice(stdout) {
    assert.notEqual(stdout, "", "the hook printed nothing");
    const lines = stdout.trim().split("\n");
    assert.equal(lines.length, 1, `one line of hook output, got: ${stdout}`);
    const output = JSON.parse(lines[0]);
    assert.deepEqual(Object.keys(output), ["systemMessage"]);
    return output.systemMessage;
  }

  it("says once that the address has no ingestion API (404), exits 0 and never prints the token", async () => {
    // A server that is not a Flightdeck origin: every path is a 404, as
    // the binary answers /ingest/ingest/v1/events.
    const stranger = await new Promise((resolve) => {
      const server = createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("404 page not found\n");
        });
      });
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
    try {
      const server = `http://127.0.0.1:${stranger.address().port}/wrong`;
      const env = hookEnv({}, { FLIGHTDECK_SERVER: server, FLIGHTDECK_TOKEN: SECRET_TOKEN, CLAUDE_SESSION_ID: randomUUID() });
      const input = sessionStartInput(privateTmp);

      const first = await runScript(input, env);
      assert.equal(first.code, 0, "the hook fails open");
      const message = notice(first.stdout);
      assert.match(message, new RegExp(`^Flightdeck: ${server} has no ingestion API at ${server}/ingest/v1/events \\(HTTP 404\\)`));
      assert.match(message, /Set FLIGHTDECK_SERVER or the plugin's server option/);
      assert.match(first.stderr, new RegExp(`^\\[flightdeck\\] cannot reach ${server}: HTTP 404\\. events dropped for this session\\.$`, "m"));

      // The same session starting again (a compaction): the POST is
      // retried and logged, the user is not told twice.
      const second = await runScript(input.replace('"startup"', '"compact"'), env);
      assert.equal(second.code, 0);
      assert.equal(second.stdout, "", "the notice is shown once per session");
      assert.match(second.stderr, /cannot reach .*: HTTP 404/);

      for (const text of [first.stdout, first.stderr, second.stdout, second.stderr]) {
        assert.ok(!text.includes(SECRET_TOKEN), "the token must not appear in the hook's output");
      }
    } finally {
      stranger.closeAllConnections?.();
      stranger.close();
    }
  });

  it("says that the server does not answer", async () => {
    // Port 1 on loopback: nothing listens there, and fetch refuses the
    // port outright, so the reason is fetch's own text.
    const result = await runScript(
      sessionStartInput(privateTmp),
      hookEnv({}, { FLIGHTDECK_SERVER: "http://127.0.0.1:1/ingest", FLIGHTDECK_TOKEN: SECRET_TOKEN, CLAUDE_SESSION_ID: randomUUID() }),
    );
    assert.equal(result.code, 0, "the hook fails open");
    const message = notice(result.stdout);
    assert.match(message, /^Flightdeck: no answer from http:\/\/127\.0\.0\.1:1 \([^)]+\)\. Start flightdeck/);
    assert.ok(!result.stdout.includes(SECRET_TOKEN) && !result.stderr.includes(SECRET_TOKEN));
  });

  it("says that the token was refused, without the token", async () => {
    const refusing = await startOrigin({ answer: 401 });
    try {
      const result = await runScript(
        sessionStartInput(privateTmp),
        hookEnv({}, {
          FLIGHTDECK_SERVER: `http://127.0.0.1:${refusing.port}/ingest`,
          FLIGHTDECK_TOKEN: SECRET_TOKEN,
          CLAUDE_SESSION_ID: randomUUID(),
        }),
      );
      assert.equal(result.code, 0, "the hook fails open");
      const message = notice(result.stdout);
      assert.match(message, new RegExp(`^Flightdeck: http://127\\.0\\.0\\.1:${refusing.port} refused the access token \\(HTTP 401\\)`));
      assert.ok(!result.stdout.includes(SECRET_TOKEN) && !result.stderr.includes(SECRET_TOKEN));
    } finally {
      refusing.server.closeAllConnections?.();
      refusing.server.close();
    }
  });

  it("leaves the notice to SessionStart: another hook's failed backstop prints nothing on stdout", async () => {
    // UserPromptSubmit's plain stdout is added to Claude's context, so a
    // hook other than SessionStart must stay silent there.
    const result = await runScript(
      JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: `cc-${randomUUID()}`, cwd: privateTmp, prompt: "hi" }),
      hookEnv({}, { FLIGHTDECK_SERVER: "http://127.0.0.1:1", FLIGHTDECK_TOKEN: SECRET_TOKEN, CLAUDE_SESSION_ID: randomUUID() }),
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /cannot reach http:\/\/127\.0\.0\.1:1: /);
  });
});
