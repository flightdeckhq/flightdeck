/**
 * T186 — The Prompts tab shows an OpenAI chat refusal.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``), two
 * runs, and on each one OpenAI chat ``post_call`` posted through
 * ingestion in the sensor's wire shape with its content captured: a call
 * whose response's message refused (``content`` null, the model's text
 * in ``refusal``, as Structured Outputs returns it), and the next call,
 * whose messages pass that refused message back. Opened in the event
 * drawer, the first call's response shows the refusal labelled
 * ``refusal`` (not the response object), and the second call's passed
 * back message shows it the same way (not ``(empty)``).
 *
 * Theme-agnostic: test ids and text only, so it runs under both the
 * neon-dark and clean-light theme projects (Rule 40c.3).
 */
import { test, expect, type Page } from "@playwright/test";
import {
  createPrivateAgent,
  endPrivateAgent,
  postPrivatePostCall,
  startPrivateAgent,
  type PrivateAgent,
} from "./_fixtures";

const QUESTION = "Explain how to get into a locked house. T186-USER";
const REFUSAL = "I'm sorry, but I can't assist with that. T186-REFUSAL";
const FOLLOW_UP = "Fine. What is the capital of France? T186-FOLLOW-UP";

const OPENAI_CALL = {
  client_type: "flightdeck_sensor",
  framework: null,
  model: "gpt-4o-mini",
  provider: "openai",
};

/** The assistant message as the SDK returns it when the model refuses. */
const REFUSED_MESSAGE = {
  annotations: [],
  audio: null,
  content: null,
  function_call: null,
  refusal: REFUSAL,
  role: "assistant",
  tool_calls: null,
};

function completion(message: Record<string, unknown>): Record<string, unknown> {
  return {
    choices: [{ finish_reason: "stop", index: 0, logprobs: null, message }],
    id: "chatcmpl-T186",
    model: "gpt-4o-mini-2024-07-18",
    object: "chat.completion",
    usage: { completion_tokens: 14, prompt_tokens: 52, total_tokens: 66 },
  };
}

function content(messages: unknown[], response: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: "openai",
    model: "gpt-4o-mini",
    system: null,
    messages,
    tools: null,
    response,
    captured_at: new Date().toISOString(),
  };
}

async function openPrompts(page: Page, eventId: string, sessionId: string) {
  await page.goto(`/events?event=${eventId}&event_session=${sessionId}`);
  const drawer = page.getByTestId("event-detail-drawer");
  await expect(drawer).toBeVisible();
  await drawer.getByTestId("detail-tab-prompts").click();
  return drawer;
}

test.describe("T186 — the Prompts tab shows a chat refusal", () => {
  let agent: PrivateAgent | undefined;

  test.afterEach(async ({ page }) => {
    if (agent) await endPrivateAgent(page, agent);
  });

  test("the refused response and the refused message passed back show the refusal labelled", async ({ page }) => {
    agent = createPrivateAgent("t186-chat-refusal", 2);
    await startPrivateAgent(page, agent);
    const [firstRun, secondRun] = agent.sessionIds as [string, string];
    const firstId = await postPrivatePostCall(
      page,
      agent,
      firstRun,
      content([{ role: "user", content: QUESTION }], completion(REFUSED_MESSAGE)),
      OPENAI_CALL,
    );
    const secondId = await postPrivatePostCall(
      page,
      agent,
      secondRun,
      content(
        [{ role: "user", content: QUESTION }, REFUSED_MESSAGE, { role: "user", content: FOLLOW_UP }],
        completion({ ...REFUSED_MESSAGE, content: "Paris. T186-ANSWER", refusal: null }),
      ),
      OPENAI_CALL,
    );

    let drawer = await openPrompts(page, firstId, firstRun);
    const response = drawer.getByTestId("prompt-box-response");
    const refusal = response.getByTestId("chat-refusal");
    await expect(refusal).toContainText("refusal");
    await expect(refusal).toContainText(REFUSAL);
    await expect(response).not.toContainText("chatcmpl-T186");
    await expect(response).toContainText("Tokens in: 52 · Tokens out: 14");

    drawer = await openPrompts(page, secondId, secondRun);
    const passedBack = drawer.getByTestId("prompt-box-message-1");
    await expect(passedBack.getByTestId("chat-refusal")).toContainText(REFUSAL);
    await expect(passedBack).not.toContainText("(empty)");
    await expect(drawer.getByTestId("prompt-box-response")).toContainText("Paris. T186-ANSWER");
    await expect(drawer.getByTestId("prompt-box-response").getByTestId("chat-refusal")).toHaveCount(0);
  });
});
