import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { MCPPolicyEntryTable } from "@/components/policy/MCPPolicyEntryTable";
import type { MCPPolicyEntry } from "@/lib/types";
import { contrastRatio, over, readThemeTokens, resolveColor, TEXT_SAFE_FLOOR, THEMES } from "./support/theme-contrast";

function entry(
  override: Partial<MCPPolicyEntry> = {},
): MCPPolicyEntry {
  return {
    id: override.id ?? `entry-${Math.random().toString(36).slice(2, 8)}`,
    policy_id: "policy-1",
    server_url: "https://maps.example.com",
    server_name: "maps",
    fingerprint: "abcdef0123456789".repeat(2).slice(0, 64),
    entry_kind: "allow",
    enforcement: null,
    created_at: "2026-05-05T00:00:00Z",
    ...override,
  };
}

describe("MCPPolicyEntryTable", () => {
  const noop = () => undefined;
  const noopAsync = async () => undefined;

  it("renders mode-aware empty-state copy under allowlist when there are no entries", () => {
    render(
      <MCPPolicyEntryTable
        entries={[]}
        mode="allowlist"
        scopeKey="global"
        flavor="global"
        scope="flavor"
        loading={false}
        onAdd={noop}
        onEdit={noop}
        onDelete={noopAsync}
        onApplied={noopAsync}
      />,
    );
    expect(
      screen.getByTestId("mcp-policy-entries-empty").textContent,
    ).toContain("Add your first allow rule to start gating this scope.");
  });

  it("renders the blocklist empty-state copy when mode is blocklist", () => {
    render(
      <MCPPolicyEntryTable
        entries={[]}
        mode="blocklist"
        scopeKey="global"
        flavor="global"
        scope="flavor"
        loading={false}
        onAdd={noop}
        onEdit={noop}
        onDelete={noopAsync}
        onApplied={noopAsync}
      />,
    );
    expect(
      screen.getByTestId("mcp-policy-entries-empty").textContent,
    ).toContain("Add your first deny rule to block specific servers.");
  });

  it("colours the decision pill per (entry_kind, enforcement) combination", () => {
    const entries: MCPPolicyEntry[] = [
      entry({ id: "e1", server_name: "allow-svc", entry_kind: "allow" }),
      entry({
        id: "e2",
        server_name: "warn-svc",
        entry_kind: "deny",
        enforcement: "warn",
      }),
      entry({
        id: "e3",
        server_name: "block-svc",
        entry_kind: "deny",
        enforcement: "block",
      }),
      entry({
        id: "e4",
        server_name: "interactive-svc",
        entry_kind: "deny",
        enforcement: "interactive",
      }),
    ];
    render(
      <MCPPolicyEntryTable
        entries={entries}
        mode="allowlist"
        scopeKey="global"
        flavor="global"
        scope="flavor"
        loading={false}
        onAdd={noop}
        onEdit={noop}
        onDelete={noopAsync}
        onApplied={noopAsync}
      />,
    );

    expect(screen.getByTestId("mcp-policy-entry-pill-e1").textContent).toBe(
      "Allow",
    );
    expect(screen.getByTestId("mcp-policy-entry-pill-e2").textContent).toBe(
      "Deny · warn",
    );
    expect(screen.getByTestId("mcp-policy-entry-pill-e3").textContent).toBe(
      "Deny · block",
    );
    expect(screen.getByTestId("mcp-policy-entry-pill-e4").textContent).toBe(
      "Deny · interactive",
    );
  });

  it("filters rows to the search needle on URL, name, and fingerprint", () => {
    const entries: MCPPolicyEntry[] = [
      entry({
        id: "search-1",
        server_name: "alpha",
        server_url: "https://alpha.example.com",
        fingerprint: "1111aaaa22223333",
      }),
      entry({
        id: "search-2",
        server_name: "beta",
        server_url: "https://beta.example.com",
        fingerprint: "4444bbbb55556666",
      }),
    ];
    render(
      <MCPPolicyEntryTable
        entries={entries}
        mode="blocklist"
        scopeKey="global"
        flavor="global"
        scope="flavor"
        loading={false}
        onAdd={noop}
        onEdit={noop}
        onDelete={noopAsync}
        onApplied={noopAsync}
      />,
    );

    fireEvent.change(
      screen.getByTestId("mcp-policy-entries-search-global"),
      { target: { value: "alpha" } },
    );

    expect(screen.queryByTestId("mcp-policy-entry-search-1")).toBeTruthy();
    expect(screen.queryByTestId("mcp-policy-entry-search-2")).toBeNull();
    expect(screen.queryByTestId("mcp-policy-entries-empty-search")).toBeNull();
  });

  it("invokes onAdd when the Add entry button is clicked", () => {
    const onAdd = vi.fn();
    render(
      <MCPPolicyEntryTable
        entries={[]}
        mode="blocklist"
        scopeKey="global"
        flavor="global"
        scope="flavor"
        loading={false}
        onAdd={onAdd}
        onEdit={noop}
        onDelete={noopAsync}
        onApplied={noopAsync}
      />,
    );

    fireEvent.click(screen.getByTestId("mcp-policy-entries-add-global"));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("invokes onEdit with the row's entry when the edit action is clicked", () => {
    const onEdit = vi.fn();
    const e = entry({ id: "row-1", server_name: "edit-target" });
    render(
      <MCPPolicyEntryTable
        entries={[e]}
        mode="allowlist"
        scopeKey="global"
        flavor="global"
        scope="flavor"
        loading={false}
        onAdd={noop}
        onEdit={onEdit}
        onDelete={noopAsync}
        onApplied={noopAsync}
      />,
    );

    const row = screen.getByTestId("mcp-policy-entry-row-1");
    fireEvent.click(within(row).getByTestId("mcp-policy-entry-edit-row-1"));

    expect(onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "row-1", server_name: "edit-target" }),
    );
  });

  it("embeds the quick-start templates link in the empty state on a flavor scope", () => {
    render(
      <MCPPolicyEntryTable
        entries={[]}
        mode="allowlist"
        scopeKey="research-agent"
        flavor="research-agent"
        scope="flavor"
        loading={false}
        onAdd={noop}
        onEdit={noop}
        onDelete={noopAsync}
        onApplied={noopAsync}
      />,
    );
    expect(
      screen.getByTestId("mcp-quickstart-templates-trigger-research-agent"),
    ).toBeTruthy();
  });

  it("hides the quick-start templates link on the global scope — apply_template returns 400 by design", () => {
    render(
      <MCPPolicyEntryTable
        entries={[]}
        mode="blocklist"
        scopeKey="global"
        flavor="global"
        scope="global"
        loading={false}
        onAdd={noop}
        onEdit={noop}
        onDelete={noopAsync}
        onApplied={noopAsync}
      />,
    );
    // Empty state still renders its mode-aware copy; only the
    // quick-start CTA is suppressed.
    expect(
      screen.getByTestId("mcp-policy-entries-empty").textContent,
    ).toContain("Add your first deny rule to block specific servers.");
    expect(
      screen.queryByTestId("mcp-quickstart-templates-trigger-global"),
    ).toBeNull();
  });

});

describe("MCPPolicyEntryTable's Deny · interactive pill, in both themes", () => {
  const TOKENS = readThemeTokens();
  const noop = () => undefined;
  const noopAsync = async () => undefined;

  /** Each decision pill's inline paint. */
  function pills() {
    render(
      <MCPPolicyEntryTable
        entries={[
          entry({ id: "allow", entry_kind: "allow" }),
          entry({ id: "warn", entry_kind: "deny", enforcement: "warn" }),
          entry({ id: "block", entry_kind: "deny", enforcement: "block" }),
          entry({ id: "interactive", entry_kind: "deny", enforcement: "interactive" }),
        ]}
        mode="allowlist"
        scopeKey="global"
        flavor="global"
        scope="flavor"
        loading={false}
        onAdd={noop}
        onEdit={noop}
        onDelete={noopAsync}
        onApplied={noopAsync}
      />,
    );
    const paint = (id: string) => {
      const style = screen.getByTestId(`mcp-policy-entry-pill-${id}`).style;
      return { background: style.background, border: style.borderColor, color: style.color };
    };
    return { allow: paint("allow"), warn: paint("warn"), block: paint("block"), interactive: paint("interactive") };
  }

  const TINT = /^color-mix\(in srgb, (.+) 12%, transparent\)$/;

  it("is built like its siblings: its hue's 12% tint, a border in the hue, and the hue's text-safe shade as text", () => {
    const all = pills();
    for (const [name, p] of Object.entries(all)) {
      const hue = TINT.exec(p.background)?.[1];
      expect(hue, `${name}: a 12% tint of its hue`).toBeDefined();
      expect(p.border, `${name}: a border in its hue`).toBe(hue);
    }
    expect(all.interactive.background).toBe("color-mix(in srgb, var(--accent) 12%, transparent)");
    expect(all.interactive.color).toBe("var(--accent-text)");
  });

  /** The pill's text on its tint over ``surface``, exact and as the 8-bit
   *  colour a browser composites; the lower of the two. */
  function pillRatio(
    interactive: ReturnType<typeof pills>["interactive"],
    theme: (typeof THEMES)[number],
    surface: string,
  ): number {
    const t = TOKENS[theme];
    const exact = over(resolveColor(t, interactive.background), resolveColor(t, surface));
    const eightBit = { r: Math.round(exact.r), g: Math.round(exact.g), b: Math.round(exact.b), a: 1 };
    const text = resolveColor(t, interactive.color);
    return Math.min(contrastRatio(text, exact), contrastRatio(text, eightBit));
  }

  it("its text reads at the floor on its tint in a row at rest (--surface)", () => {
    const { interactive } = pills();
    for (const theme of THEMES) {
      expect(pillRatio(interactive, theme, "var(--surface)"), theme).toBeGreaterThanOrEqual(TEXT_SAFE_FLOOR);
    }
  });

  // A known gap: a hovered row (hover:bg-(--bg-elevated)) puts the tint over
  // the elevated surface, and --accent-text there reads 4.32:1 (dark) and
  // 4.43:1 (light), under the floor; reaching it needs a shade --accent-text
  // does not have, which is the maintainer's call. This case fails once it
  // reads at the floor, when it becomes a check that it does.
  it("its text on its tint in a hovered row (--bg-elevated) stays under the floor (a known gap)", () => {
    const { interactive } = pills();
    for (const theme of THEMES) {
      expect(pillRatio(interactive, theme, "var(--bg-elevated)"), theme).toBeLessThan(TEXT_SAFE_FLOOR);
    }
  });
});
