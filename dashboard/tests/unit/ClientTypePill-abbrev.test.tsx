import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClientTypePill } from "@/components/facets/ClientTypePill";
import { ClientType } from "@/lib/agent-identity";

/**
 * F1 abbreviation variant: the AGENT facet sidebar appends a tight
 * CC/SDK pill alongside the agent_name to disambiguate two agents
 * whose only difference is client_type. The default ``full`` variant
 * still renders the human label everywhere it shipped before.
 */
describe("ClientTypePill abbrev variant (F1)", () => {
  it("renders 'CC' for claude_code under variant=abbrev", () => {
    render(
      <ClientTypePill
        clientType={ClientType.ClaudeCode}
        variant="abbrev"
        testId="pill-cc"
      />,
    );
    expect(screen.getByTestId("pill-cc")).toHaveTextContent("CC");
  });

  it("renders 'SDK' for flightdeck_sensor under variant=abbrev", () => {
    render(
      <ClientTypePill
        clientType={ClientType.FlightdeckSensor}
        variant="abbrev"
        testId="pill-sdk"
      />,
    );
    expect(screen.getByTestId("pill-sdk")).toHaveTextContent("SDK");
  });

  it("default variant still renders the full label", () => {
    render(
      <ClientTypePill
        clientType={ClientType.ClaudeCode}
        testId="pill-full"
      />,
    );
    expect(screen.getByTestId("pill-full")).toHaveTextContent("Claude Code");
  });

  it("explicit variant=full renders the full label", () => {
    render(
      <ClientTypePill
        clientType={ClientType.FlightdeckSensor}
        variant="full"
        testId="pill-full-sensor"
      />,
    );
    expect(screen.getByTestId("pill-full-sensor")).toHaveTextContent("Sensor");
  });

  it("title attribute always carries the wire client_type value", () => {
    render(
      <ClientTypePill
        clientType={ClientType.FlightdeckSensor}
        variant="abbrev"
        testId="pill-title"
      />,
    );
    expect(screen.getByTestId("pill-title")).toHaveAttribute(
      "title",
      "client_type=flightdeck_sensor",
    );
  });
});
