/**
 * T183 — The Prompts tab shows a Gemini thinking response.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``), one
 * run, and on it one google-genai ``post_call`` posted through ingestion
 * in the sensor's wire shape with its content captured: a thinking
 * model's answer, whose response body holds a ``thought`` part (the
 * model's summarised thinking) and the answer part carrying a
 * ``thoughtSignature``, with a system instruction and one user turn.
 * Opened in the event drawer, the system instruction shows under its own
 * name, the thought is marked ``thought`` apart from the answer, the
 * signature is one mark naming the field (its opaque value not in
 * Rendered), the token line counts the thoughts as output, and JSON holds
 * the signature as stored.
 *
 * Theme-agnostic: test ids and text only, so it runs under both the
 * neon-dark and clean-light theme projects (Rule 40c.3).
 */
import { test, expect } from "@playwright/test";
import {
  createPrivateAgent,
  endPrivateAgent,
  postPrivatePostCall,
  startPrivateAgent,
  type PrivateAgent,
} from "./_fixtures";

const SYSTEM = "Answer with the number only. T183-SYSTEM";
const QUESTION = "What is 17 * 23? T183-USER";
const THOUGHT = "Seventeen times twenty is 340, plus 51 is 391. T183-THOUGHT";
const SIGNATURE = "EusDCugDAWkUfRT183signature";

const GEMINI_CALL = {
  client_type: "flightdeck_sensor",
  framework: null,
  model: "gemini-3.1-flash-lite",
  provider: "google",
};

function thinkingContent(): Record<string, unknown> {
  return {
    provider: "google",
    model: "gemini-3.1-flash-lite",
    system: [{ text: SYSTEM }],
    messages: [],
    tools: null,
    input: [{ parts: [{ text: QUESTION }], role: "user" }],
    response: {
      candidates: [
        {
          content: {
            parts: [{ text: THOUGHT, thought: true }, { text: "391", thoughtSignature: SIGNATURE }],
            role: "model",
          },
          finishReason: "STOP",
          index: 0,
        },
      ],
      modelVersion: "gemini-3.1-flash-lite",
      responseId: "t183",
      usageMetadata: { promptTokenCount: 17, candidatesTokenCount: 3, thoughtsTokenCount: 120, totalTokenCount: 140 },
    },
    captured_at: new Date().toISOString(),
  };
}

test.describe("T183 — the Prompts tab shows a Gemini thinking response", () => {
  let agent: PrivateAgent | undefined;

  test.afterEach(async ({ page }) => {
    if (agent) await endPrivateAgent(page, agent);
  });

  test("the thought apart from the answer, the signature a mark with its value in JSON", async ({ page }) => {
    agent = createPrivateAgent("t183-gemini-thinking", 1);
    await startPrivateAgent(page, agent);
    const sessionId = agent.sessionIds[0]!;
    const eventId = await postPrivatePostCall(page, agent, sessionId, thinkingContent(), GEMINI_CALL);

    await page.goto(`/events?event=${eventId}&event_session=${sessionId}`);
    const drawer = page.getByTestId("event-detail-drawer");
    await expect(drawer).toBeVisible();
    await drawer.getByTestId("detail-tab-prompts").click();
    await expect(drawer.getByTestId("prompt-viewer-gemini")).toBeVisible();

    await expect(drawer.getByRole("button", { name: /^System instruction/ })).toBeVisible();
    await expect(drawer.getByTestId("prompt-box-system")).toContainText("T183-SYSTEM");
    await expect(drawer.getByTestId("prompt-box-content-0")).toContainText("T183-USER");

    const response = drawer.getByTestId("prompt-box-response");
    const thought = response.getByTestId("gemini-part-thought");
    await expect(thought).toContainText("thought");
    await expect(thought).toContainText("T183-THOUGHT");
    await expect(response).toContainText("391");
    // One mark for the candidate's signed parts, the value not shown.
    await expect(response.getByTestId("gemini-thought-signature")).toHaveText("thoughtSignature · opaque bytes, in JSON");
    // The token line every provider's response shows: the prompt, and
    // the candidates with the thoughts.
    await expect(response).toContainText("Tokens in: 17 · Tokens out: 123");
    await expect(response).not.toContainText(SIGNATURE);
    await expect(response.getByTestId("gemini-finish-reason")).toHaveCount(0);

    await drawer.getByTestId("prompt-box-response-json").click();
    await expect(drawer.getByTestId("prompt-box-response-json-view")).toContainText(`"thoughtSignature": "${SIGNATURE}"`);
  });
});
