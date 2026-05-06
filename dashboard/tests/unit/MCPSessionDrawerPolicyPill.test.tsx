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

  // Step 6.7 A2 — mode_default subdued render. Pre-fix the
  // fallthrough case rendered as "unknown" with bg=transparent +
  // fg=text-muted, which read as no-pill against the drawer
  // surface. The new contract: render the actual mode-default
  // decision (allow/warn/block) with subdued styling — dashed
  // border, lower-opacity fill, italic text, "(default)" suffix
  // — so operators see what would happen AND that it's not an
  // explicit policy entry.

  it("renders mode_default block as 'block (default)' with subdued treatment", () => {
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
    const pill = screen.getByTestId(
      "mcp-server-policy-pill-fallthrough-svc-block-default",
    );
    expect(pill.textContent).toBe("block (default)");
  });

  it("renders mode_default allow as 'allow (default)' (blocklist-mode fallthrough)", () => {
    renderPill(
      {
        kind: "ok",
        result: {
          decision: "allow",
          decision_path: "mode_default",
          policy_id: "p",
          scope: "global",
          fingerprint: "abcdef0123456789",
        },
      },
      "blocklist-orphan",
    );
    expect(
      screen.getByTestId(
        "mcp-server-policy-pill-blocklist-orphan-allow-default",
      ).textContent,
    ).toBe("allow (default)");
  });

  it("subdued styling distinguishes mode_default from explicit entries (dashed + italic + lower-opacity)", () => {
    // Visual-weight lock: explicit entries render with a SOLID
    // border, upright text, and 12% chroma fill. Mode-default
    // renders with a DASHED border, italic text, and 4% chroma
    // fill. These three signals stack so the difference reads
    // in 1 second of glance — the supervisor's locked
    // distinguishability check.
    const explicit = render(
      <TooltipProvider>
        <MCPServerPolicyPill
          decision={{
            kind: "ok",
            result: {
              decision: "block",
              decision_path: "flavor_entry",
              policy_id: "p",
              scope: "flavor:prod",
              fingerprint: "abcdef0123456789",
            },
          }}
          testId="explicit-block"
        />
      </TooltipProvider>,
    );
    const explicitPill = explicit.getByTestId(
      "mcp-server-policy-pill-explicit-block-block",
    );
    const explicitStyle = (explicitPill as HTMLElement).style;
    expect(explicitStyle.borderStyle).toBe("solid");
    expect(explicitStyle.fontStyle).toBe("normal");
    expect(explicitStyle.background).toContain("12%");

    const fallthrough = render(
      <TooltipProvider>
        <MCPServerPolicyPill
          decision={{
            kind: "ok",
            result: {
              decision: "block",
              decision_path: "mode_default",
              policy_id: "p",
              scope: "global",
              fingerprint: "abcdef0123456789",
            },
          }}
          testId="default-block"
        />
      </TooltipProvider>,
    );
    const fallthroughPill = fallthrough.getByTestId(
      "mcp-server-policy-pill-default-block-block-default",
    );
    const fallthroughStyle = (fallthroughPill as HTMLElement).style;
    expect(fallthroughStyle.borderStyle).toBe("dashed");
    expect(fallthroughStyle.fontStyle).toBe("italic");
    expect(fallthroughStyle.background).toContain("4%");
    // Both pills share the same chroma colour (--danger for
    // block) — only the visual weight signals differ.
    expect(explicitStyle.color).toBe(fallthroughStyle.color);
    expect(explicitStyle.borderColor).toBe(fallthroughStyle.borderColor);
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
