import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { EmbeddingsContentViewer } from "@/components/session/EmbeddingsContentViewer";
import { EMBEDDING_TOKEN_IDS_PREVIEW_COUNT as TOKEN_IDS_PREVIEW_COUNT } from "@/lib/constants";
import type { EventContent } from "@/lib/types";

// The expanded event row's embeddings viewer renders every stored input
// as it did before the Prompts tab showed embeddings inputs through the
// same component, every byte of its markup and in every state its
// buttons reach: fixtures/embeddings-viewer-pinned-before-prompts-input.json
// holds the markup from main's viewer (dc712bff). Set
// CAPTURE_PINNED_MARKUP=1 to write that file again from the component
// in place, only for a change meant to alter this markup, and check its
// diff.

const PINNED_FILE = resolve(__dirname, "fixtures/embeddings-viewer-pinned-before-prompts-input.json");
const CAPTURE = process.env.CAPTURE_PINNED_MARKUP === "1";

let mockContent: EventContent | null = null;

vi.mock("@/lib/api", () => ({
  fetchEventContent: vi.fn(() => Promise.resolve(mockContent)),
}));

beforeEach(() => {
  mockContent = null;
  vi.clearAllMocks();
});

/** A token-id input longer than the viewer's preview. */
const LONG_TOKEN_IDS = Array.from({ length: TOKEN_IDS_PREVIEW_COUNT + 7 }, (_, i) => 1000 + i);

/** Stored inputs of every shape the viewer tells apart, and the
 *  provider whose content stores each. */
const INPUTS: Record<string, { provider: string; input: unknown }> = {
  string_short: { provider: "openai", input: "The quick brown fox." },
  string_long: { provider: "openai", input: `Long input ${"lorem ipsum ".repeat(40)}end.` },
  string_markup: { provider: "litellm", input: "<b>not bold</b> & <script>x()</script>" },
  string_empty: { provider: "openai", input: "" },
  tokens_short: { provider: "openai", input: [101, 202, 303] },
  tokens_one: { provider: "openai", input: [7] },
  tokens_long: { provider: "openai", input: LONG_TOKEN_IDS },
  list: { provider: "openai", input: ["alpha", "beta", "gamma"] },
  list_one: { provider: "litellm", input: ["only"] },
  token_lists: { provider: "openai", input: [[1, 2, 3], LONG_TOKEN_IDS] },
  json_object: { provider: "openai", input: { text: "hello", n: 2 } },
  json_empty_list: { provider: "openai", input: [] },
  json_mixed_list: { provider: "litellm", input: ["a", 1] },
  gemini_contents: {
    provider: "google",
    input: [
      { parts: [{ text: "hello" }], role: "user" },
      { parts: [{ text: "world" }], role: "user" },
    ],
  },
  vertex_texts: { provider: "google", input: ["hello", "world"] },
  absent: { provider: "openai", input: null },
};

function content(name: string): EventContent {
  const { provider, input } = INPUTS[name]!;
  return {
    event_id: `e-pinned-embed-${name}`,
    session_id: "s",
    provider,
    model: provider === "google" ? "gemini-embedding-001" : "text-embedding-3-small",
    system_prompt: null,
    messages: [],
    tools: null,
    response: {},
    input,
    captured_at: "2026-11-18T00:00:00Z",
  } as EventContent;
}

/** The markup the viewer settles on, then after each of its buttons is
 *  clicked in turn (a list's toggle, then "Show full inputs"), so the
 *  open states are pinned as well. */
async function markups(name: string): Promise<string[]> {
  mockContent = content(name);
  const { container, unmount } = render(<EmbeddingsContentViewer eventId={`e-pinned-embed-${name}`} hasContent />);
  await waitFor(() => expect(container.querySelector('[data-state="loading"]')).toBeNull());
  const states = [container.innerHTML];
  // Each click can add a button ("Show full inputs" once a list opens).
  for (let i = 0; i < 4; i++) {
    const buttons = Array.from(container.querySelectorAll("button"));
    const next = buttons[i];
    if (!next) break;
    fireEvent.click(next);
    states.push(container.innerHTML);
  }
  unmount();
  return states;
}

function notCaptured(): string {
  const { container } = render(<EmbeddingsContentViewer eventId="e-pinned-embed-off" hasContent={false} />);
  const html = container.innerHTML;
  cleanup();
  return html;
}

describe("EmbeddingsContentViewer: the expanded row's markup is as it was", () => {
  if (CAPTURE) {
    it("captures the markup", async () => {
      const captured: Record<string, string[]> = { not_captured: [notCaptured()] };
      for (const name of Object.keys(INPUTS)) captured[name] = await markups(name);
      writeFileSync(PINNED_FILE, `${JSON.stringify(captured, null, 2)}\n`);
    });
    return;
  }
  const expected = JSON.parse(readFileSync(PINNED_FILE, "utf8")) as Record<string, string[]>;
  it("not captured", () => {
    expect([notCaptured()]).toEqual(expected.not_captured);
  });
  for (const name of Object.keys(INPUTS)) {
    it(name, async () => {
      expect(await markups(name)).toEqual(expected[name]);
    });
  }
});
