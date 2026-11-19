import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PromptViewer } from "@/components/session/PromptViewer";
import type { EventContent, OutputDimensions } from "@/lib/types";

// An embeddings event's Prompts tab, every byte of its markup: in its
// Rendered view, with the input's list or cut text opened, and with each
// box in its JSON view, for each provider's stored input shapes (the
// real stored bodies of fixtures/embeddings-content.json and built ones
// in the shapes the sensor stores). fixtures/prompts-pinned-embeddings.json
// holds the markup from the view's first version, its entries with
// output_dimensions captured again when that section was titled Output
// (its toggle naming the event's output_dimensions; the entries without
// did not move). Set
// CAPTURE_PINNED_MARKUP=1 to write that file again from the component in
// place, only for a change meant to alter this markup, and check its
// diff.

const PINNED_FILE = resolve(__dirname, "fixtures/prompts-pinned-embeddings.json");
const CAPTURE = process.env.CAPTURE_PINNED_MARKUP === "1";

let mockContent: EventContent | null = null;

vi.mock("@/lib/api", () => ({
  fetchEventContent: vi.fn(() => Promise.resolve(mockContent)),
}));

beforeEach(() => {
  mockContent = null;
  vi.clearAllMocks();
});

interface Stored {
  output_dimensions: OutputDimensions | null;
  content: EventContent;
}

const live = JSON.parse(readFileSync(resolve(__dirname, "fixtures/embeddings-content.json"), "utf8")) as Record<
  string,
  Stored
>;

function built(name: string, provider: string, model: string, input: unknown): Stored {
  return {
    output_dimensions: { count: 2, dimension: 768 },
    content: {
      event_id: `e-pinned-embed-${name}`,
      session_id: "s",
      provider,
      model,
      system_prompt: null,
      messages: [],
      tools: null,
      response: {},
      ...(input === undefined ? {} : { input }),
      captured_at: "2026-11-18T00:00:00Z",
    } as EventContent,
  };
}

const PINNED: Record<string, Stored> = {
  ...Object.fromEntries(Object.entries(live).filter(([name]) => !name.startsWith("_"))),
  litellm_token_lists: built("litellm-token-lists", "litellm", "text-embedding-3-small", [[1, 2, 3], [4, 5]]),
  openai_object: built("openai-object", "openai", "text-embedding-3-small", { text: "hello", n: 2 }),
  vertex_texts: built("vertex-texts", "google", "gemini-embedding-001", ["hello", "world"]),
  openai_no_input: built("openai-no-input", "openai", "text-embedding-3-small", undefined),
};

/** The tab's markup: Rendered; then with every button of the input box's
 *  view clicked (a list opened, a cut text shown whole, a token-id
 *  list's items whole); then with every box in its JSON view. Without
 *  output_dimensions, the Rendered markup only. */
async function markups(stored: Stored, withDimensions: boolean): Promise<string[]> {
  mockContent = stored.content;
  const { container, unmount } = render(
    <PromptViewer
      eventId={stored.content.event_id}
      eventType="embeddings"
      outputDimensions={withDimensions ? stored.output_dimensions : null}
    />,
  );
  await screen.findByTestId("prompt-viewer-embeddings");
  const states = [container.innerHTML];
  if (!withDimensions) {
    unmount();
    return states;
  }
  const box = screen.getByTestId("prompt-box-embeddings-input");
  for (let i = 0; i < 3; i++) {
    const viewButtons = Array.from(box.querySelectorAll('[data-testid="embeddings-content-viewer"] button'));
    const next = viewButtons[i];
    if (!next) break;
    fireEvent.click(next);
  }
  states.push(container.innerHTML);
  for (const button of Array.from(container.querySelectorAll('button[data-testid$="-json"]'))) fireEvent.click(button);
  states.push(container.innerHTML);
  unmount();
  return states;
}

describe("PromptViewer: an embeddings event's Prompts tab markup is pinned", () => {
  if (CAPTURE) {
    it("captures the markup", async () => {
      const captured: Record<string, string[]> = {};
      for (const [name, stored] of Object.entries(PINNED)) {
        captured[name] = await markups(stored, true);
        captured[`${name}_without_dimensions`] = await markups(stored, false);
      }
      writeFileSync(PINNED_FILE, `${JSON.stringify(captured, null, 2)}\n`);
    });
    return;
  }
  const expected = JSON.parse(readFileSync(PINNED_FILE, "utf8")) as Record<string, string[]>;
  for (const [name, stored] of Object.entries(PINNED)) {
    it(name, async () => {
      expect(await markups(stored, true)).toEqual(expected[name]);
    });
    it(`${name}, without output_dimensions`, async () => {
      expect(await markups(stored, false)).toEqual(expected[`${name}_without_dimensions`]);
    });
  }
});
