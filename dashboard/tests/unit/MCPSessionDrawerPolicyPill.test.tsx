import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { TooltipProvider } from "@/components/ui/tooltip";
import {
  MCPServerPolicyPill,
  type MCPServerDecision,
} from "@/components/policy/MCPServerPolicyPill";

function renderPill(decision: MCPServerDecision | undefined, testId = "test") {
  return render(
    <TooltipProvider>
      <MCPServerPolicyPill decision={decision} testId={testId} />
    </TooltipProvider>,
  );
}

describe("MCPServerPolicyPill", () => {
  it("renders a skeleton pill while the resolve call is in flight", () => {
    renderPill({ kind: "loading" }, "loading-svc");
    expect(
      screen.getByTestId("mcp-server-policy-pill-loading-svc-skeleton"),
    ).toBeTruthy();
  });

  it("renders a skeleton when no decision has been issued yet", () => {
    renderPill(undefined, "no-decision");
    expect(
      screen.getByTestId("mcp-server-policy-pill-no-decision-skeleton"),
    ).toBeTruthy();
  });

  it("renders a 'no URL' pill when the captured fingerprint lacks server_url", () => {
    renderPill({ kind: "missing" }, "no-url-svc");
    const pill = screen.getByTestId(
      "mcp-server-policy-pill-no-url-svc-missing",
    );
    expect(pill.textContent).toBe("no URL");
  });

  it("renders the allow pill (success-green) for a flavor_entry allow decision", () => {
    renderPill(
      {
        kind: "ok",
        result: {
          decision: "allow",
          decision_path: "flavor_entry",
          policy_id: "p",
          scope: "flavor:prod",
          fingerprint: "abcdef0123456789",
        },
      },
      "allow-svc",
    );
    expect(
      screen.getByTestId("mcp-server-policy-pill-allow-svc-allow").textContent,
    ).toBe("allow");
  });

  it("renders the warn pill (amber) for a flavor_entry warn decision", () => {
    renderPill(
      {
        kind: "ok",
        result: {
          decision: "warn",
          decision_path: "global_entry",
          policy_id: "p",
          scope: "global",
          fingerprint: "abcdef0123456789",
        },
      },
      "warn-svc",
    );
    expect(
      screen.getByTestId("mcp-server-policy-pill-warn-svc-warn").textContent,
    ).toBe("warn");
  });

  it("renders the block pill (danger) for a flavor_entry block decision", () => {
    renderPill(
      {
        kind: "ok",
        result: {
          decision: "block",
          decision_path: "flavor_entry",
          policy_id: "p",
          scope: "flavor:prod",
          fingerprint: "abcdef0123456789",
        },
      },
      "block-svc",
    );
    expect(
      screen.getByTestId("mcp-server-policy-pill-block-svc-block").textContent,
    ).toBe("block");
  });

  it("renders the unknown pill when the decision_path is mode_default (no entry matched)", () => {
    renderPill(
      {
        kind: "ok",
        result: {
          decision: "block",
          decision_path: "mode_default",
          policy_id: "p",
          scope: "global",
          fingerprint: "abcdef0123456789",
        },
      },
      "fallthrough-svc",
    );
    expect(
      screen.getByTestId(
        "mcp-server-policy-pill-fallthrough-svc-unknown",
      ).textContent,
    ).toBe("unknown");
  });

  it("renders an error pill carrying the error message when the resolve call rejected", () => {
    renderPill(
      { kind: "error", message: "boom" },
      "broken-svc",
    );
    expect(
      screen.getByTestId("mcp-server-policy-pill-broken-svc-error")
        .textContent,
    ).toBe("error");
  });
});
