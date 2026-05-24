import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { AgentTypeBadge } from "@/components/facets/AgentTypeBadge";
import {
  AGENT_TYPE_COLOR,
  AGENT_TYPE_LABEL,
  AgentType,
} from "@/lib/agent-identity";

describe("AgentTypeBadge", () => {
  it("renders the Coding label with the violet primary accent", () => {
    const { getByText } = render(
      <AgentTypeBadge agentType={AgentType.Coding} />,
    );
    const badge = getByText(AGENT_TYPE_LABEL[AgentType.Coding]);
    expect(badge.style.background).toBe(AGENT_TYPE_COLOR[AgentType.Coding].bg);
    expect(badge.style.color).toBe(AGENT_TYPE_COLOR[AgentType.Coding].fg);
    // The coding badge owns the violet ``--primary`` cue so it does
    // not read as plain neutral text next to the client_type pill.
    expect(AGENT_TYPE_COLOR[AgentType.Coding].fg).toContain("--primary");
  });

  it("renders the Production label with the muted neutral treatment", () => {
    const { getByText } = render(
      <AgentTypeBadge agentType={AgentType.Production} />,
    );
    const badge = getByText(AGENT_TYPE_LABEL[AgentType.Production]);
    expect(badge.style.background).toBe(
      AGENT_TYPE_COLOR[AgentType.Production].bg,
    );
    expect(badge.style.color).toBe(AGENT_TYPE_COLOR[AgentType.Production].fg);
  });

  it("distinguishes the two agent_types by colour (regression guard)", () => {
    const coding = AGENT_TYPE_COLOR[AgentType.Coding];
    const production = AGENT_TYPE_COLOR[AgentType.Production];
    expect(coding.bg).not.toBe(production.bg);
    expect(coding.fg).not.toBe(production.fg);
    expect(coding.border).not.toBe(production.border);
  });

  it("honours the testId prop", () => {
    const { getByTestId } = render(
      <AgentTypeBadge agentType={AgentType.Coding} testId="at-badge" />,
    );
    expect(getByTestId("at-badge")).toBeTruthy();
  });
});
