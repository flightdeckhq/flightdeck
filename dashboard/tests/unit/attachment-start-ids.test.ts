import { describe, it, expect } from "vitest";
import { attachmentStartIds } from "@/lib/events";

/** A run's event at ``at``. */
const ev = (id: string, at: string, event_type = "session_start") => ({ id, event_type, occurred_at: at });

const ORIGINAL = ev("original", "2026-04-07T10:00:00Z");

describe("attachmentStartIds", () => {
  it("matches a client's start to the attachment stamped a moment later", () => {
    const ids = attachmentStartIds(
      [ORIGINAL, ev("call", "2026-04-07T10:01:00Z", "post_call"), ev("again", "2026-04-07T10:02:00Z")],
      ["2026-04-07T10:02:01Z"],
    );
    expect(ids).toEqual(new Set(["again"]));
  });

  it("matches a start dated by its record to an attachment stamped minutes later", () => {
    // The OpenTelemetry re-attaching start: dated before the late
    // records it wraps, while the attach is stamped on arrival.
    const ids = attachmentStartIds(
      [ORIGINAL, ev("late", "2026-04-07T10:02:00Z")],
      ["2026-04-07T10:09:30Z"],
    );
    expect(ids).toEqual(new Set(["late"]));
  });

  it("matches a recorded Claude Code resume: one start near its attach, one seconds before", () => {
    // A live replay of the recorded SendMessage resume: the original
    // start, a re-attaching start dated 5.8 s before its attach, and one
    // dated 0.05 s before its own.
    const ids = attachmentStartIds(
      [
        ev("original", "2026-11-04T11:47:36.544421Z"),
        ev("resume1", "2026-11-04T11:47:43.035421Z"),
        ev("resume2", "2026-11-04T11:47:49.323421Z"),
      ],
      ["2026-11-04T11:47:48.819Z", "2026-11-04T11:47:49.374Z"],
    );
    expect(ids).toEqual(new Set(["resume1", "resume2"]));
  });

  it("never gives the original start to a later attachment", () => {
    // Two attachments, but only one re-attaching start loaded besides
    // the original: the second attachment stays unmatched.
    const ids = attachmentStartIds(
      [ORIGINAL, ev("late", "2026-04-07T10:02:00Z"), ev("call", "2026-04-07T10:03:00Z", "post_call")],
      ["2026-04-07T10:05:00Z"],
    );
    expect(ids).toEqual(new Set(["late"]));
  });

  it("takes every loaded start when the original is not loaded", () => {
    // The drawer holds only the newest events, from a call of the first
    // run on: two re-attaching starts, as many as the run's
    // attachments, so neither is the original.
    const ids = attachmentStartIds(
      [
        ev("call", "2026-04-07T10:01:00Z", "post_call"),
        ev("late1", "2026-04-07T10:02:00Z"),
        ev("late2", "2026-04-07T10:20:00Z"),
      ],
      ["2026-04-07T10:09:30Z", "2026-04-07T10:25:00Z"],
    );
    expect(ids).toEqual(new Set(["late1", "late2"]));
  });

  it("treats a start no loaded event precedes as the original", () => {
    // An attachment whose start is not stored: the run's own first
    // start, the earliest event loaded, is not given to it.
    const ids = attachmentStartIds(
      [ev("first", "2026-04-07T10:00:00Z"), ev("call", "2026-04-07T10:01:00Z", "post_call")],
      ["2026-04-07T10:05:00Z"],
    );
    expect(ids.size).toBe(0);
  });

  it("gives each attachment its own start, the latest one at or before it", () => {
    const ids = attachmentStartIds(
      [ORIGINAL, ev("late1", "2026-04-07T10:02:00Z"), ev("late2", "2026-04-07T10:20:00Z")],
      ["2026-04-07T10:09:30Z", "2026-04-07T10:25:00Z"],
    );
    expect(ids).toEqual(new Set(["late1", "late2"]));
  });

  it("gives a close attachment the nearest start, not the first one in the window", () => {
    const ids = attachmentStartIds(
      [ORIGINAL, ev("early", "2026-04-07T10:02:00.100Z"), ev("near", "2026-04-07T10:02:01.900Z")],
      ["2026-04-07T10:02:02Z"],
    );
    expect(ids).toEqual(new Set(["near"]));
  });

  it("gives a late-stamped attachment the latest start before it, not the earliest", () => {
    // A start with no attachment of its own sits between the original
    // and the re-attaching start; the attachment takes the one just
    // before it.
    const ids = attachmentStartIds(
      [ORIGINAL, ev("other", "2026-04-07T10:01:00Z"), ev("late", "2026-04-07T10:02:00Z")],
      ["2026-04-07T10:09:30Z"],
    );
    expect(ids).toEqual(new Set(["late"]));
  });

  it("leaves a start dated after every attachment unmatched", () => {
    const ids = attachmentStartIds(
      [ORIGINAL, ev("after", "2026-04-07T10:30:00Z")],
      ["2026-04-07T10:09:30Z"],
    );
    expect(ids.size).toBe(0);
  });

  it("marks nothing without attachments, and ignores events that are not starts", () => {
    expect(attachmentStartIds([ORIGINAL, ev("again", "2026-04-07T10:02:00Z")], []).size).toBe(0);
    expect(attachmentStartIds([ORIGINAL, ev("again", "2026-04-07T10:02:00Z")], undefined).size).toBe(0);
    const ids = attachmentStartIds(
      [ORIGINAL, ev("call", "2026-04-07T10:02:00Z", "post_call")],
      ["2026-04-07T10:02:01Z"],
    );
    expect(ids.size).toBe(0);
  });
});
