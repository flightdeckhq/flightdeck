// D146: tests for MCPServerDecisionText. Replaces the previous
// MCPSessionDrawerPolicyPill tests; locks the inline-text rendering
// and the explicit-vs-mode-default visual distinction by testid +
// inline style + suffix copy.

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  MCPServerDecisionText,
  type MCPServerDecision,
} from "@/components/policy/MCPServerDecisionText";

function renderText(decision: MCPServerDecision | undefined, testId = "svc") {
  return render(
    <MCPServerDecisionText decision={decision} testId={testId} />,
  );
}

describe("MCPServerDecisionText", () => {
  it("renders a skeleton while loading", () => {
    renderText({ kind: "loading" }, "loading-svc");
    expect(
      screen.getByTestId("mcp-server-decision-loading-svc-skeleton"),
    ).toBeTruthy();
  });

  it("renders a skeleton when decision is undefined", () => {
    renderText(undefined, "no-decision");
    expect(
      screen.getByTestId("mcp-server-decision-no-decision-skeleton"),
    ).toBeTruthy();
  });

  it("renders 'no URL' italic muted text on missing kind", () => {
    renderText({ kind: "missing" }, "no-url-svc");
    const el = screen.getByTestId("mcp-server-decision-no-url-svc-missing");
    expect(el.textContent).toBe("no URL");
    expect(el.getAttribute("title")).toContain(
      "The sensor didn't capture a URL",
    );
  });

  it("renders 'error' text with the message in title on error kind", () => {
    renderText(
      { kind: "error", message: "policy fetch failed" },
      "boom-svc",
    );
    const el = screen.getByTestId("mcp-server-decision-boom-svc-error");
    expect(el.textContent).toBe("error");
    expect(el.getAttribute("title")).toBe("policy fetch failed");
  });

  it("renders ALLOW (uppercase, no italic, no '(default)') on explicit allow", () => {
    renderText(
      {
        kind: "ok",
        result: {
          decision: "allow",
          decision_path: "flavor_entry",
          policy_id: "p",
          scope: "flavor:prod",
          fingerprint: "abc",
        },
      },
      "allow-svc",
    );
    const el = screen.getByTestId("mcp-server-decision-allow-svc-allow");
    expect(el.textContent).toContain("ALLOW");
    expect(el.textContent).not.toContain("(default)");
  });

  it("renders WARN on explicit warn", () => {
    renderText(
      {
        kind: "ok",
        result: {
          decision: "warn",
          decision_path: "global_entry",
          policy_id: "p",
          scope: "global",
          fingerprint: "abc",
        },
      },
      "warn-svc",
    );
    expect(
      screen.getByTestId("mcp-server-decision-warn-svc-warn").textContent,
    ).toContain("WARN");
  });

  it("renders BLOCK on explicit block", () => {
    renderText(
      {
        kind: "ok",
        result: {
          decision: "block",
          decision_path: "flavor_entry",
          policy_id: "p",
          scope: "flavor:prod",
          fingerprint: "abc",
        },
      },
      "block-svc",
    );
    expect(
      screen.getByTestId("mcp-server-decision-block-svc-block").textContent,
    ).toContain("BLOCK");
  });

  it("renders ALLOW (default) with italic + reduced opacity + attribution title on mode_default allow", () => {
    renderText(
      {
        kind: "ok",
        result: {
          decision: "allow",
          decision_path: "mode_default",
          policy_id: "p",
          scope: "global",
          fingerprint: "abc",
        },
      },
      "fallthrough-svc",
    );
    const el = screen.getByTestId(
      "mcp-server-decision-fallthrough-svc-allow-default",
    );
    expect(el.textContent).toContain("ALLOW");
    expect(el.textContent).toContain("(default)");
    // The inner span carries the italic + opacity inline style; assert
    // by querying it (the colored chroma span is the only one carrying
    // fontStyle: italic).
    const italicSpan = el.querySelector("span[style*='italic']");
    expect(italicSpan).toBeTruthy();
    expect(italicSpan?.getAttribute("title")).toContain("global mode default");
  });

  it("renders BLOCK (default) on mode_default block", () => {
    renderText(
      {
        kind: "ok",
        result: {
          decision: "block",
          decision_path: "mode_default",
          policy_id: "p",
          scope: "global",
          fingerprint: "abc",
        },
      },
      "default-block-svc",
    );
    const el = screen.getByTestId(
      "mcp-server-decision-default-block-svc-block-default",
    );
    expect(el.textContent).toContain("BLOCK");
    expect(el.textContent).toContain("(default)");
  });

  it("renders the middle-dot separator on the decision span", () => {
    renderText(
      {
        kind: "ok",
        result: {
          decision: "allow",
          decision_path: "flavor_entry",
          policy_id: "p",
          scope: "flavor:prod",
          fingerprint: "abc",
        },
      },
      "dot-svc",
    );
    expect(
      screen.getByTestId("mcp-server-decision-dot-svc-allow").textContent,
    ).toContain("·");
  });
});
