import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MCPPolicyHeader } from "@/components/policy/MCPPolicyHeader";
import type { MCPPolicy } from "@/lib/types";
import { contrastRatio, readThemeTokens, resolveColor, TEXT_SAFE_FLOOR, THEMES, type Rgba } from "./support/theme-contrast";

/**
 * The shared tabs and switch draw on defined theme tokens in both themes:
 * the active tab is raised on its tab list, and each focus ring's offset
 * gap is the colour of the surface the control sits on (an undefined
 * offset colour invalidates the whole ring, which then does not draw).
 */

const TOKENS = readThemeTokens();

/** The token a Tailwind shorthand class names, e.g. ``bg-(--surface)``
 *  under ``variant`` (``data-[state=active]:``, ``focus-visible:``). */
function classToken(el: Element, variant: string, utility: string): string {
  const escaped = `${variant}${utility}`.replace(/[[\]()=:]/g, "\\$&");
  const m = new RegExp(`(?:^|\\s)${escaped}-\\((--[a-z0-9-]+)\\)(?=\\s|$)`).exec(el.getAttribute("class") ?? "");
  if (!m) throw new Error(`no ${variant}${utility}-(--token) class on <${el.tagName.toLowerCase()}>`);
  return `var(${m[1]})`;
}

const same = (a: Rgba, b: Rgba) => a.r === b.r && a.g === b.g && a.b === b.b && a.a === b.a;

describe("the shared tabs on defined tokens, in both themes", () => {
  function renderTabs() {
    render(
      <Tabs value="b">
        <TabsList data-testid="list">
          <TabsTrigger value="a">Token Budget</TabsTrigger>
          <TabsTrigger value="b">MCP Protection</TabsTrigger>
        </TabsList>
      </Tabs>,
    );
    const active = screen.getByRole("tab", { name: "MCP Protection" });
    expect(active.getAttribute("data-state")).toBe("active");
    return { list: screen.getByTestId("list"), active };
  }

  it("the active tab is raised on its tab list, and its text reads at the floor on it", () => {
    const { list, active } = renderTabs();
    for (const theme of THEMES) {
      const t = TOKENS[theme];
      const listBg = resolveColor(t, classToken(list, "", "bg"));
      const activeBg = resolveColor(t, classToken(active, "data-[state=active]:", "bg"));
      expect(activeBg.a, `${theme}: an opaque active tab`).toBe(1);
      expect(same(activeBg, listBg), `${theme}: the active tab differs from its tab list`).toBe(false);
      const text = resolveColor(t, classToken(active, "data-[state=active]:", "text"));
      expect(contrastRatio(text, activeBg), theme).toBeGreaterThanOrEqual(TEXT_SAFE_FLOOR);
    }
  });

  it("a focused tab's ring offset is the tab list's colour, the surface a tab sits on", () => {
    const { list, active } = renderTabs();
    for (const theme of THEMES) {
      const t = TOKENS[theme];
      const offset = resolveColor(t, classToken(active, "focus-visible:", "ring-offset"));
      expect(same(offset, resolveColor(t, classToken(list, "", "bg"))), theme).toBe(true);
    }
  });
});

describe("the shared switch on defined tokens, in both themes", () => {
  it("a focused switch's ring offset is the colour of the policy header panel it sits on", () => {
    const policy: MCPPolicy = {
      id: "policy-1",
      scope: "global",
      scope_value: null,
      mode: "allowlist",
      block_on_uncertainty: true,
      created_at: "2026-05-05T00:00:00Z",
      updated_at: "2026-05-05T00:00:00Z",
      entries: [],
    };
    const noopAsync = async () => undefined;
    render(
      <MCPPolicyHeader
        policy={policy}
        scopeKey="global"
        modeEditable
        globalMode="allowlist"
        onModeChange={noopAsync}
        onBlockOnUncertaintyChange={noopAsync}
      />,
    );
    const toggle = screen.getByTestId("mcp-policy-bou-switch-global");
    const panel = screen.getByTestId("mcp-policy-header-global");
    const panelBg = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/.exec(panel.getAttribute("style") ?? "")?.[1]?.trim();
    expect(panelBg).toBeDefined();
    for (const theme of THEMES) {
      const t = TOKENS[theme];
      const offset = resolveColor(t, classToken(toggle, "focus-visible:", "ring-offset"));
      expect(same(offset, resolveColor(t, panelBg!)), theme).toBe(true);
    }
  });
});
