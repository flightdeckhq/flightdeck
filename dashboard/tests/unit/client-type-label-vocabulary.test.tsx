import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClientTypePill } from "@/components/facets/ClientTypePill";
import {
  CLIENT_TYPE_LABEL,
  ClientType,
} from "@/lib/agent-identity";

/**
 * S-LBL-1..3 vocabulary lock-in. F1 originally shipped a parallel
 * shorthand vocabulary (``CC`` / ``SDK``) for the Investigate AGENT
 * facet pill, which diverged from Fleet's canonical ``Claude Code`` /
 * ``Sensor`` labels. Different label for the same concept depending
 * on which surface the operator was looking at — a defect.
 *
 * These assertions lock the vocabulary down at the unit level so a
 * future commit that re-introduces parallel labels (or drifts the
 * canonical map) trips the test:
 *
 *   1. CLIENT_TYPE_LABEL is the single source of truth.
 *   2. The pill renders that label verbatim (CSS uppercase
 *      transforms it to ``CLAUDE CODE`` / ``SENSOR`` visually,
 *      but the textContent the test sees is the data form).
 *   3. The ``compact`` size variant — used by the AGENT facet —
 *      renders the same label as the default size used by Fleet.
 */
describe("client_type label vocabulary (S-LBL)", () => {
  it("CLIENT_TYPE_LABEL maps to the canonical strings", () => {
    expect(CLIENT_TYPE_LABEL[ClientType.ClaudeCode]).toBe("Claude Code");
    expect(CLIENT_TYPE_LABEL[ClientType.FlightdeckSensor]).toBe("Sensor");
  });

  it("ClientTypePill (default size) renders the canonical Claude Code label", () => {
    render(
      <ClientTypePill clientType={ClientType.ClaudeCode} testId="pill-cc" />,
    );
    const pill = screen.getByTestId("pill-cc");
    expect(pill.textContent).toBe("Claude Code");
    // CSS uppercase styling is applied via Tailwind ``uppercase`` —
    // the rendered glyphs are CLAUDE CODE; we assert the data
    // string here so the test is theme/CSS-agnostic.
    expect(pill).toHaveClass("uppercase");
  });

  it("ClientTypePill (default size) renders the canonical Sensor label", () => {
    render(
      <ClientTypePill
        clientType={ClientType.FlightdeckSensor}
        testId="pill-sensor"
      />,
    );
    expect(screen.getByTestId("pill-sensor").textContent).toBe("Sensor");
  });

  it("compact-size pill renders the same label as default size", () => {
    // Fleet renders compact pills in its sidebar/swimlane. The
    // AGENT facet ALSO uses compact. The label must not branch
    // on size.
    render(
      <ClientTypePill
        clientType={ClientType.ClaudeCode}
        size="compact"
        testId="pill-compact"
      />,
    );
    expect(screen.getByTestId("pill-compact").textContent).toBe(
      CLIENT_TYPE_LABEL[ClientType.ClaudeCode],
    );
  });

  it("never renders the abbreviated CC/SDK shorthand (regression guard)", () => {
    render(
      <>
        <ClientTypePill
          clientType={ClientType.ClaudeCode}
          testId="pill-no-cc"
        />
        <ClientTypePill
          clientType={ClientType.FlightdeckSensor}
          testId="pill-no-sdk"
        />
      </>,
    );
    expect(screen.getByTestId("pill-no-cc").textContent).not.toBe("CC");
    expect(screen.getByTestId("pill-no-sdk").textContent).not.toBe("SDK");
  });

  it("title attribute carries the wire client_type value", () => {
    render(
      <ClientTypePill
        clientType={ClientType.FlightdeckSensor}
        testId="pill-title"
      />,
    );
    expect(screen.getByTestId("pill-title")).toHaveAttribute(
      "title",
      "client_type=flightdeck_sensor",
    );
  });
});
