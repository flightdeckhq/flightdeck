import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ClaudeCodeLogo, ClaudeCodeIconSvg } from "@/components/ui/claude-code-logo";
import { CLAUDE_CODE_ICON } from "@/components/ui/provider-icons";
import {
  getClaudeCodeVersion,
  isClaudeCodeSession,
} from "@/lib/models";

describe("ClaudeCodeLogo", () => {
  it("renders an <svg> with the canonical viewBox and path", () => {
    const { container } = render(<ClaudeCodeLogo size={16} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("viewBox")).toBe(CLAUDE_CODE_ICON.viewBox);
    const path = svg?.querySelector("path");
    expect(path?.getAttribute("d")).toBe(CLAUDE_CODE_ICON.path);
    // fill-rule is required -- the mark uses a ring + chevron and
    // nonzero would paint the interior solid.
    expect(path?.getAttribute("fill-rule")).toBe("evenodd");
  });

  it("respects size prop for width and height", () => {
    const { container } = render(<ClaudeCodeLogo size={24} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("24");
    expect(svg?.getAttribute("height")).toBe("24");
  });

  it("carries an aria-label for screen readers", () => {
    render(<ClaudeCodeLogo size={14} />);
    expect(screen.getByLabelText("Claude Code")).toBeInTheDocument();
  });
});

describe("ClaudeCodeIconSvg", () => {
  it("renders as nested <svg> positioned at (x, y)", () => {
    // Nested in an outer SVG so the test mirrors how the component is
    // actually used inside recharts ticks.
    const { container } = render(
      <svg>
        <ClaudeCodeIconSvg x={10} y={20} size={12} />
      </svg>,
    );
    const inner = container.querySelectorAll("svg")[1];
    expect(inner).toBeDefined();
    expect(inner.getAttribute("x")).toBe("10");
    expect(inner.getAttribute("y")).toBe("20");
    expect(inner.getAttribute("width")).toBe("12");
    expect(inner.getAttribute("viewBox")).toBe(CLAUDE_CODE_ICON.viewBox);
    // Same source of truth as ClaudeCodeLogo.
    const path = inner.querySelector("path");
    expect(path?.getAttribute("d")).toBe(CLAUDE_CODE_ICON.path);
    expect(path?.getAttribute("fill-rule")).toBe("evenodd");
  });
});

describe("isClaudeCodeSession", () => {
  it("matches on flavor=claude-code", () => {
    expect(isClaudeCodeSession({ flavor: "claude-code" })).toBe(true);
  });

  it("matches on context.frameworks containing claude-code", () => {
    expect(
      isClaudeCodeSession({
        flavor: "some-renamed-flavor",
        context: { frameworks: ["claude-code"] },
      }),
    ).toBe(true);
  });

  it("matches on a versioned frameworks entry", () => {
    expect(
      isClaudeCodeSession({
        flavor: "another",
        context: { frameworks: ["claude-code/2.1.112"] },
      }),
    ).toBe(true);
  });

  it("returns false when neither flavor nor frameworks hint Claude Code", () => {
    expect(
      isClaudeCodeSession({
        flavor: "research-agent",
        context: { frameworks: ["langchain/0.1.12"] },
      }),
    ).toBe(false);
    expect(isClaudeCodeSession({ flavor: "research-agent" })).toBe(false);
  });

  it("handles missing context and non-array frameworks gracefully", () => {
    expect(isClaudeCodeSession({})).toBe(false);
    expect(
      isClaudeCodeSession({ flavor: "x", context: { frameworks: "oops" } }),
    ).toBe(false);
  });
});

describe("getClaudeCodeVersion", () => {
  it("parses the version from claude-code/<ver>", () => {
    expect(
      getClaudeCodeVersion({ context: { frameworks: ["claude-code/2.1.112"] } }),
    ).toBe("2.1.112");
  });

  it("returns null when the frameworks entry is versionless", () => {
    expect(
      getClaudeCodeVersion({ context: { frameworks: ["claude-code"] } }),
    ).toBe(null);
  });

  it("returns null when no frameworks array exists", () => {
    expect(getClaudeCodeVersion({ context: {} })).toBe(null);
    expect(getClaudeCodeVersion({})).toBe(null);
  });

  it("skips non-string entries and picks the claude-code one", () => {
    expect(
      getClaudeCodeVersion({
        context: {
          frameworks: [{ bogus: true }, "crewai/0.42.0", "claude-code/2.1.112"],
        },
      }),
    ).toBe("2.1.112");
  });
});
