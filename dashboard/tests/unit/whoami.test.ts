// D147: tests for the whoami zustand slice. Mocks fetchWhoami so
// no network round-trip leaks; covers happy paths (admin / viewer),
// the in-flight guard, error handling, and reset().

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/api");
  return {
    ...actual,
    fetchWhoami: vi.fn(),
  };
});

import { fetchWhoami } from "@/lib/api";
import { useWhoamiStore } from "@/store/whoami";

const fetchMock = fetchWhoami as unknown as Mock;

beforeEach(() => {
  fetchMock.mockReset();
  useWhoamiStore.setState({
    role: null,
    tokenId: null,
    loading: false,
    error: null,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useWhoamiStore", () => {
  it("populates role + tokenId on a successful admin fetch", async () => {
    fetchMock.mockResolvedValue({ role: "admin", token_id: "uuid-admin" });
    await useWhoamiStore.getState().fetchWhoami();
    const s = useWhoamiStore.getState();
    expect(s.role).toBe("admin");
    expect(s.tokenId).toBe("uuid-admin");
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("populates role + tokenId on a successful viewer fetch", async () => {
    fetchMock.mockResolvedValue({ role: "viewer", token_id: "uuid-viewer" });
    await useWhoamiStore.getState().fetchWhoami();
    const s = useWhoamiStore.getState();
    expect(s.role).toBe("viewer");
    expect(s.tokenId).toBe("uuid-viewer");
  });

  it("sets error and clears role on a failed fetch", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await useWhoamiStore.getState().fetchWhoami();
    const s = useWhoamiStore.getState();
    expect(s.role).toBeNull();
    expect(s.tokenId).toBeNull();
    expect(s.error).toBe("network down");
  });

  it("guards against concurrent in-flight fetches (idempotent)", async () => {
    let resolveFn!: (v: { role: "admin" | "viewer"; token_id: string }) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFn = resolve;
      }),
    );

    const first = useWhoamiStore.getState().fetchWhoami();
    // Second call while first is in flight is a no-op.
    const second = useWhoamiStore.getState().fetchWhoami();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFn({ role: "admin", token_id: "uuid-admin" });
    await first;
    await second;
    expect(useWhoamiStore.getState().role).toBe("admin");
  });

  it("reset() returns the slice to its initial state", () => {
    useWhoamiStore.setState({
      role: "admin",
      tokenId: "uuid-admin",
      loading: false,
      error: null,
    });
    useWhoamiStore.getState().reset();
    const s = useWhoamiStore.getState();
    expect(s.role).toBeNull();
    expect(s.tokenId).toBeNull();
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });
});
