import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { MCPPolicyEntryTable } from "@/components/policy/MCPPolicyEntryTable";
import type { MCPPolicyEntry } from "@/lib/types";
import { useWhoamiStore } from "@/store/whoami";

beforeEach(() => {
  // D147: most tests assume admin role for the mutation buttons
  // they exercise; viewer tests below override per-case.
  useWhoamiStore.setState({
    role: "admin",
    tokenId: "test-token",
    loading: false,
    error: null,
  });
});

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
        loading={false}
        onAdd={noop}
        onEdit={noop}
        onDelete={noopAsync}
      />,
    );
    expect(screen.getByTestId("mcp-policy-entries-empty").textContent).toBe(
      "Add your first allow rule to start gating this scope.",
    );
  });

  it("renders the blocklist empty-state copy when mode is blocklist", () => {
    render(
      <MCPPolicyEntryTable
        entries={[]}
        mode="blocklist"
        scopeKey="global"
        loading={false}
        onAdd={noop}
        onEdit={noop}
        onDelete={noopAsync}
      />,
    );
    expect(screen.getByTestId("mcp-policy-entries-empty").textContent).toBe(
      "Add your first deny rule to block specific servers.",
    );
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
        loading={false}
        onAdd={noop}
        onEdit={noop}
        onDelete={noopAsync}
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
        loading={false}
        onAdd={noop}
        onEdit={noop}
        onDelete={noopAsync}
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
        loading={false}
        onAdd={onAdd}
        onEdit={noop}
        onDelete={noopAsync}
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
        loading={false}
        onAdd={noop}
        onEdit={onEdit}
        onDelete={noopAsync}
      />,
    );

    const row = screen.getByTestId("mcp-policy-entry-row-1");
    fireEvent.click(within(row).getByTestId("mcp-policy-entry-edit-row-1"));

    expect(onEdit).toHaveBeenCalledWith(
      expect.objectContaining({ id: "row-1", server_name: "edit-target" }),
    );
  });

  it("hides Add Entry button + row Edit/Delete actions when role is viewer (D147)", () => {
    useWhoamiStore.setState({
      role: "viewer",
      tokenId: "viewer-token",
      loading: false,
      error: null,
    });
    render(
      <MCPPolicyEntryTable
        entries={[entry({ id: "row-1", server_name: "alpha" })]}
        mode="allowlist"
        scopeKey="global"
        loading={false}
        onAdd={() => undefined}
        onEdit={() => undefined}
        onDelete={async () => undefined}
      />,
    );

    expect(screen.queryByTestId("mcp-policy-entries-add-global")).toBeNull();
    expect(screen.queryByTestId("mcp-policy-entry-edit-row-1")).toBeNull();
    expect(screen.queryByTestId("mcp-policy-entry-delete-row-1")).toBeNull();
    // Row content still renders — D147 only hides action affordances.
    expect(screen.getByTestId("mcp-policy-entry-row-1").textContent).toContain(
      "alpha",
    );
  });
});
