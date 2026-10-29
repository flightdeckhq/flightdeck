// core/poster.mjs serializeEvent: every event body stays within
// MAX_EVENT_BODY_BYTES, the 1 MiB ingestion and NATS limit less
// headroom, by cutting the strings of its captured content.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_EVENT_BODY_BYTES,
  capStrings,
  encodedBytes,
  serializeEvent,
  truncationMarker,
} from "../hooks/scripts/core/poster.mjs";

function bytes(text) {
  return Buffer.byteLength(text, "utf8");
}

// Runs fn with stderr captured; returns [result, lines written].
function withStderr(fn) {
  const written = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => {
    written.push(String(s));
    return true;
  };
  try {
    return [fn(), written];
  } finally {
    process.stderr.write = orig;
  }
}

function postCall(content) {
  return { event_type: "post_call", session_id: "s1", tokens_input: 42, has_content: true, content };
}

describe("serializeEvent", () => {
  it("sends an event within the limit unchanged and silently", () => {
    const payload = postCall({ messages: [{ role: "user", content: "hi" }], response: [] });
    const [body, written] = withStderr(() => serializeEvent(payload));
    assert.equal(body, JSON.stringify(payload));
    assert.deepEqual(written, []);
  });

  it("cuts the longest strings of oversized content and keeps the rest", () => {
    const big = "a".repeat(3 * 1024 * 1024);
    const payload = postCall({
      provider: "anthropic",
      messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: big }] }],
      tools: [{ type: "tool_use", name: "Read", input: { file_path: "/x" } }],
      response: [{ type: "text", text: "short answer" }],
    });
    const [body, written] = withStderr(() => serializeEvent(payload));
    assert.ok(bytes(body) <= MAX_EVENT_BODY_BYTES, `${bytes(body)} bytes`);
    const sent = JSON.parse(body);
    assert.equal(sent.tokens_input, 42);
    assert.equal(sent.has_content, true);
    assert.equal(sent.content.provider, "anthropic");
    assert.deepEqual(sent.content.tools, payload.content.tools);
    assert.deepEqual(sent.content.response, payload.content.response);
    const cut = sent.content.messages[0].content[0].content;
    const match = cut.match(/… \[flightdeck: kept (\d+) of (\d+) bytes to fit the event size limit\]$/);
    assert.ok(match, "the cut string ends with the marker");
    assert.equal(Number(match[2]), bytes(big));
    assert.equal(cut, "a".repeat(Number(match[1])) + truncationMarker(Number(match[1]), bytes(big)));
    // Most of the budget goes to the content, not to an over-eager cut.
    assert.ok(Number(match[1]) > MAX_EVENT_BODY_BYTES * 0.9, `kept ${match[1]} bytes`);
    assert.equal(written.length, 1);
    assert.match(written[0], /^\[flightdeck\] WARN: post_call event is \d+ bytes; content strings over \d+ bytes were cut/);
  });

  it("gives every long string the same cap", () => {
    const payload = postCall({ messages: [{ role: "user", content: "b".repeat(600000) }], response: [{ type: "text", text: "c".repeat(600000) }] });
    const [body] = withStderr(() => serializeEvent(payload));
    const sent = JSON.parse(body);
    const keptOf = (s) => Number(s.match(/kept (\d+) of/)[1]);
    assert.equal(keptOf(sent.content.messages[0].content), keptOf(sent.content.response[0].text));
    assert.ok(bytes(body) <= MAX_EVENT_BODY_BYTES);
  });

  it("never splits a multi-byte character", () => {
    const payload = postCall({ messages: [{ role: "user", content: "\u{1F600}".repeat(400000) }] });
    const [body] = withStderr(() => serializeEvent(payload));
    assert.ok(bytes(body) <= MAX_EVENT_BODY_BYTES);
    const text = JSON.parse(body).content.messages[0].content;
    assert.ok(!text.includes("�"));
    assert.match(text, /^(\u{1F600})+… \[flightdeck: kept \d+ of 1600000 bytes/u);
  });

  it("leaves a string alone when the marker would only lengthen it", () => {
    const short = "s".repeat(70);
    assert.equal(capStrings(short, 10), short);
    const long = "l".repeat(200);
    assert.equal(capStrings(long, 10), "l".repeat(10) + truncationMarker(10, 200));
    assert.deepEqual(capStrings({ a: [short, long], n: 3, b: null }, 10), {
      a: [short, "l".repeat(10) + truncationMarker(10, 200)],
      n: 3,
      b: null,
    });
  });

  it("measures a body as ingestion's Go encoder writes it", () => {
    assert.equal(encodedBytes('{"a":"x"}'), 9);
    // <, > and & become six-byte \u003c escapes; U+2028 / U+2029 six-byte escapes.
    assert.equal(encodedBytes('{"a":"<&>"}'), 8 + 3 * 6);
    assert.equal(encodedBytes('{"a":"\u2028"}'), 8 + 6);
    assert.equal(encodedBytes('{"a":"é"}'), Buffer.byteLength('{"a":"é"}', "utf8"));
  });

  it("keeps markup-heavy content within the limit once re-encoded", () => {
    // 700 KiB of "<a>" is under the limit in UTF-8 and about 3.5x over it
    // after Go escapes every bracket.
    const markup = "<a>".repeat(240000);
    const payload = { event_type: "session_start", session_id: "s1", has_content: true, content: { response: { body: markup } } };
    const [body] = withStderr(() => serializeEvent(payload));
    assert.ok(encodedBytes(body) <= MAX_EVENT_BODY_BYTES, `${encodedBytes(body)} encoded bytes`);
    assert.match(JSON.parse(body).content.response.body, /^(<a>)+.*… \[flightdeck: kept \d+ of 720000 bytes/s);
  });

  it("sends the event without its content when no cut fits", () => {
    // 60,000 empty blocks: the structure alone is over the limit.
    const blocks = Array.from({ length: 60000 }, () => ({ type: "text", text: "" }));
    const payload = postCall({ messages: [], response: blocks });
    const [body, written] = withStderr(() => serializeEvent(payload));
    const sent = JSON.parse(body);
    assert.equal(sent.content, null);
    assert.equal(sent.has_content, false);
    assert.equal(sent.tokens_input, 42);
    assert.match(written[0], /its content cannot be cut to fit the event size limit; the event is sent without it/);
  });

  it("sends an oversized event without content as it is", () => {
    const payload = { event_type: "tool_call", session_id: "s1", content: null, note: "q".repeat(MAX_EVENT_BODY_BYTES) };
    const [body, written] = withStderr(() => serializeEvent(payload));
    assert.equal(body, JSON.stringify(payload));
    assert.deepEqual(written, []);
  });

  it("keeps the content of an event that is over the limit without it", () => {
    const payload = { ...postCall({ messages: [{ role: "user", content: "hi" }] }), note: "q".repeat(MAX_EVENT_BODY_BYTES) };
    const [body, written] = withStderr(() => serializeEvent(payload));
    assert.equal(body, JSON.stringify(payload));
    assert.match(written[0], /post_call event is \d+ bytes and over the event size limit without its content/);
  });

  it("stays under the 1 MiB ingestion and NATS limit with room to spare", () => {
    assert.ok(MAX_EVENT_BODY_BYTES <= 0.8 * 1024 * 1024);
  });
});
