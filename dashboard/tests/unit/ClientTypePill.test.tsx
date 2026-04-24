import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ClientTypePill } from "@/components/facets/ClientTypePill";
import {
  CLIENT_TYPE_COLOR,
  CLIENT_TYPE_LABEL,
  ClientType,
} from "@/lib/agent-identity";

describe("ClientTypePill", () => {
  it("renders the Claude Code label with the claude-code amber brand colour", () => {
    const { getByText } = render(
      <ClientTypePill clientType={ClientType.ClaudeCode} />,
    );
    const pill = getByText(CLIENT_TYPE_LABEL[ClientType.ClaudeCode]);
    expect(pill.style.background).toBe(CLIENT_TYPE_COLOR[ClientType.ClaudeCode].bg);
    expect(pill.style.color).toBe(CLIENT_TYPE_COLOR[ClientType.ClaudeCode].fg);
    // Regression guard: the pill must reference the brand amber
    // (``--claude-code``) rather than the generic violet ``--primary``
    // so it does not collide with the CODING AGENT badge rendered
    // next to it in the Fleet / Investigate tables.
    expect(CLIENT_TYPE_COLOR[ClientType.ClaudeCode].fg).toContain("--claude-code");
    expect(CLIENT_TYPE_COLOR[ClientType.ClaudeCode].fg).not.toContain("--primary");
  });

  it("renders the Sensor label with the cyan colour family", () => {
    const { getByText } = render(
      <ClientTypePill clientType={ClientType.FlightdeckSensor} />,
    );
    const pill = getByText(CLIENT_TYPE_LABEL[ClientType.FlightdeckSensor]);
    expect(pill.style.background).toBe(
      CLIENT_TYPE_COLOR[ClientType.FlightdeckSensor].bg,
    );
    expect(pill.style.color).toBe(CLIENT_TYPE_COLOR[ClientType.FlightdeckSensor].fg);
  });

  it("distinguishes the two client_types by colour (regression guard)", () => {
    // Catches the prior state where both pills rendered identically
    // with neutral text-muted + bg-elevated styles.
    const claude = CLIENT_TYPE_COLOR[ClientType.ClaudeCode];
    const sensor = CLIENT_TYPE_COLOR[ClientType.FlightdeckSensor];
    expect(claude.bg).not.toBe(sensor.bg);
    expect(claude.fg).not.toBe(sensor.fg);
    expect(claude.border).not.toBe(sensor.border);
  });

  it("honours the testId prop for sidebar / table callers", () => {
    const { getByTestId } = render(
      <ClientTypePill
        clientType={ClientType.ClaudeCode}
        testId="my-custom-id"
      />,
    );
    expect(getByTestId("my-custom-id")).toBeTruthy();
  });
});
