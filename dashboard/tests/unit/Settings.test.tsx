import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Settings } from "@/pages/Settings";
import type { AccessToken, CreatedAccessToken } from "@/lib/types";

// Mock the API layer. Each test seeds `tokensSeed` / `createResult`
// via the helpers below; the mock functions close over those refs so
// rerenders in a single test share the same backing store.
const state: {
  tokens: AccessToken[];
  createResult: CreatedAccessToken | null;
  createCalls: string[];
  renameCalls: Array<[string, string]>;
  deleteCalls: string[];
  createError: string | null;
  deleteError: string | null;
  renameError: string | null;
} = {
  tokens: [],
  createResult: null,
  createCalls: [],
  renameCalls: [],
  deleteCalls: [],
  createError: null,
  deleteError: null,
  renameError: null,
};

vi.mock("@/lib/api", () => ({
  fetchAccessTokens: vi.fn(async () => state.tokens),
  createAccessToken: vi.fn(async (name: string) => {
    state.createCalls.push(name);
    if (state.createError) throw new Error(state.createError);
    return state.createResult!;
  }),
  deleteAccessToken: vi.fn(async (id: string) => {
    state.deleteCalls.push(id);
    if (state.deleteError) throw new Error(state.deleteError);
    state.tokens = state.tokens.filter((t) => t.id !== id);
  }),
  renameAccessToken: vi.fn(async (id: string, name: string) => {
    state.renameCalls.push([id, name]);
    if (state.renameError) throw new Error(state.renameError);
    state.tokens = state.tokens.map((t) =>
      t.id === id ? { ...t, name } : t,
    );
    return { ...state.tokens.find((t) => t.id === id)! };
  }),
}));

function renderSettings() {
  return render(
    <MemoryRouter>
      <Settings />
    </MemoryRouter>,
  );
}

const devToken: AccessToken = {
  id: "dev-1",
  name: "Development Token",
  prefix: "tok_dev_",
  created_at: new Date(Date.now() - 1000 * 60 * 60).toISOString(),
  last_used_at: null,
};

const prodToken: AccessToken = {
  id: "prod-1",
  name: "Production K8s",
  prefix: "ftd_a3f8",
  created_at: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
  last_used_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(),
};

beforeEach(() => {
  state.tokens = [];
  state.createResult = null;
  state.createCalls = [];
  state.renameCalls = [];
  state.deleteCalls = [];
  state.createError = null;
  state.deleteError = null;
  state.renameError = null;
});

describe("Settings page", () => {
  it("renders the header and token table", async () => {
    state.tokens = [devToken];
    renderSettings();

    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Access Tokens" }),
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(
        screen.getByTestId(`access-token-row-${devToken.id}`),
      ).toBeInTheDocument();
    });
  });

  it("shows the DEV banner when only the Development Token exists", async () => {
    state.tokens = [devToken];
    renderSettings();

    await waitFor(() => {
      expect(screen.getByTestId("settings-dev-banner")).toBeInTheDocument();
    });
  });

  it("hides the DEV banner when a production token exists", async () => {
    state.tokens = [devToken, prodToken];
    renderSettings();

    await waitFor(() => {
      expect(
        screen.getByTestId(`access-token-row-${prodToken.id}`),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("settings-dev-banner")).not.toBeInTheDocument();
  });

  it("disables rename/delete on the Development Token row and shows DEV badge", async () => {
    state.tokens = [devToken, prodToken];
    renderSettings();

    await waitFor(() => {
      expect(
        screen.getByTestId(`access-token-dev-badge-${devToken.id}`),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId(`access-token-rename-${devToken.id}`),
    ).toBeDisabled();
    expect(
      screen.getByTestId(`access-token-delete-${devToken.id}`),
    ).toBeDisabled();
    // Real tokens stay enabled.
    expect(
      screen.getByTestId(`access-token-rename-${prodToken.id}`),
    ).not.toBeDisabled();
    expect(
      screen.getByTestId(`access-token-delete-${prodToken.id}`),
    ).not.toBeDisabled();
  });

  it("create flow: name step → created step with full token value", async () => {
    state.tokens = [devToken];
    state.createResult = {
      id: "prod-2",
      name: "Staging",
      prefix: "ftd_abcd",
      token: "ftd_abcd1234567890abcdef1234567890ab",
      created_at: new Date().toISOString(),
    };
    renderSettings();

    await waitFor(() =>
      expect(screen.getByText("Create Access Token")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Create Access Token"));

    const nameInput = screen.getByTestId("create-access-token-name-input");
    fireEvent.change(nameInput, { target: { value: "Staging" } });

    // Append the newly-created token to the mock store so the next
    // fetchAccessTokens reflects it in the table refresh triggered
    // by onCreated().
    state.tokens = [
      devToken,
      {
        id: state.createResult.id,
        name: state.createResult.name,
        prefix: state.createResult.prefix,
        created_at: state.createResult.created_at,
        last_used_at: null,
      },
    ];

    fireEvent.click(screen.getByTestId("create-access-token-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("created-access-token-value")).toHaveTextContent(
        state.createResult!.token,
      ),
    );
    expect(screen.getByTestId("created-access-token-warning")).toBeInTheDocument();
    expect(state.createCalls).toEqual(["Staging"]);
  });

  it("create flow: empty name shows validation error and does not call API", async () => {
    state.tokens = [];
    renderSettings();

    await waitFor(() =>
      expect(screen.getByText("Create Access Token")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByText("Create Access Token"));
    fireEvent.click(screen.getByTestId("create-access-token-submit"));

    expect(await screen.findByText("Name is required")).toBeInTheDocument();
    expect(state.createCalls).toEqual([]);
  });

  it("delete flow: inline confirmation then API call", async () => {
    state.tokens = [devToken, prodToken];
    renderSettings();

    await waitFor(() =>
      expect(
        screen.getByTestId(`access-token-row-${prodToken.id}`),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId(`access-token-delete-${prodToken.id}`));
    expect(await screen.findByText("Delete?")).toBeInTheDocument();

    fireEvent.click(
      screen.getByTestId(`access-token-confirm-delete-${prodToken.id}`),
    );

    await waitFor(() => expect(state.deleteCalls).toEqual([prodToken.id]));
    await waitFor(() =>
      expect(
        screen.queryByTestId(`access-token-row-${prodToken.id}`),
      ).not.toBeInTheDocument(),
    );
  });

  it("rename flow: inline edit Enter saves via PATCH", async () => {
    state.tokens = [devToken, prodToken];
    renderSettings();

    await waitFor(() =>
      expect(
        screen.getByTestId(`access-token-row-${prodToken.id}`),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId(`access-token-rename-${prodToken.id}`));
    const input = await screen.findByTestId(
      `access-token-name-input-${prodToken.id}`,
    );
    fireEvent.change(input, { target: { value: "Production K8s Main" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(state.renameCalls).toEqual([[prodToken.id, "Production K8s Main"]]),
    );
  });

  it("rename flow: Escape cancels without calling PATCH", async () => {
    state.tokens = [devToken, prodToken];
    renderSettings();

    await waitFor(() =>
      expect(
        screen.getByTestId(`access-token-row-${prodToken.id}`),
      ).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId(`access-token-rename-${prodToken.id}`));
    const input = await screen.findByTestId(
      `access-token-name-input-${prodToken.id}`,
    );
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(state.renameCalls).toEqual([]);
  });
});
