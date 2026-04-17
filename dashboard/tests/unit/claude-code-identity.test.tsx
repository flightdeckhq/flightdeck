import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  CLAUDE_CODE_TOOLTIP,
  ClaudeCodeIconSvg,
  ClaudeCodeLogo,
} from "@/components/ui/claude-code-logo";
import { CodingAgentBadge } from "@/components/ui/coding-agent-badge";
import { ProviderLogo } from "@/components/ui/provider-logo";
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

  it("emits a <title> and aria-label for hover tooltip + a11y", () => {
    const { container } = render(<ClaudeCodeLogo size={14} />);
    const title = container.querySelector("svg > title");
    expect(title?.textContent).toBe(CLAUDE_CODE_TOOLTIP);
    expect(screen.getByLabelText(CLAUDE_CODE_TOOLTIP)).toBeInTheDocument();
  });

  it("honours custom title prop", () => {
    const { container } = render(
      <ClaudeCodeLogo size={14} title="Different label" />,
    );
    const title = container.querySelector("svg > title");
    expect(title?.textContent).toBe("Different label");
  });

  it("suppresses tooltip when title=''", () => {
    const { container } = render(<ClaudeCodeLogo size={14} title="" />);
    // Drawer case: adjacent visible label makes the icon redundant
    // for screen readers, so the title child is omitted and the svg
    // is marked aria-hidden.
    expect(container.querySelector("svg > title")).toBeNull();
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
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

  it("emits an SVG <title> tooltip", () => {
    const { container } = render(
      <svg>
        <ClaudeCodeIconSvg x={0} y={0} size={14} />
      </svg>,
    );
    const title = container.querySelector("svg svg > title");
    expect(title?.textContent).toBe(CLAUDE_CODE_TOOLTIP);
  });
});

describe("ProviderLogo tooltips", () => {
  it("adds a <title> naming the provider on bespoke marks", () => {
    const { container } = render(<ProviderLogo provider="anthropic" />);
    const title = container.querySelector("svg > title");
    expect(title?.textContent).toBe("Anthropic");
  });

  it("adds a <title> on the Sparkles fallback too", () => {
    // google has no bespoke mark (PROVIDER_ICONS[google] === null) so
    // the fallback Sparkles renders. Previously silent -- the title
    // ensures hover still explains what the icon represents.
    const { container } = render(<ProviderLogo provider="google" />);
    const title = container.querySelector("title");
    expect(title?.textContent).toBe("Google");
  });

  it("honours title='' opt-out for adjacent-label callers", () => {
    const { container } = render(
      <ProviderLogo provider="anthropic" title="" />,
    );
    expect(container.querySelector("svg > title")).toBeNull();
  });
});

describe("CodingAgentBadge", () => {
  it("renders the Coding agent pill", () => {
    render(<CodingAgentBadge />);
    expect(screen.getByTestId("coding-agent-badge")).toHaveTextContent(
      "Coding agent",
    );
  });

  it("carries a title tooltip explaining the observer-only caveat", () => {
    render(<CodingAgentBadge />);
    const pill = screen.getByTestId("coding-agent-badge");
    expect(pill.getAttribute("title")).toMatch(/coding agent/i);
    expect(pill.getAttribute("title")).toMatch(/kill switch/i);
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
