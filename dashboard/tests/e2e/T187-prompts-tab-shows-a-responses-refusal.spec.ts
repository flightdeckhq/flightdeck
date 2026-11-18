/**
 * T187 — The Prompts tab shows an OpenAI Responses refusal.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``), two
 * runs, and on each one OpenAI Responses ``post_call`` posted through
 * ingestion in the sensor's wire shape with its content captured: a call
 * whose response's message refused (a ``refusal`` content part, as
 * Structured Outputs returns it), and the next call, whose input passes
 * that message back. Opened in the event drawer, the first call's
 * response shows the refusal labelled ``refusal`` (not the response
 * object), with the same markup the second call's input shows the
 * passed-back part with.
 *
 * Theme-agnostic: test ids and text only, so it runs under both the
 * neon-dark and clean-light theme projects (Rule 40c.3).
 */
import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import {
  createPrivateAgent,
  endPrivateAgent,
  postPrivatePostCall,
  startPrivateAgent,
  type PrivateAgent,
} from "./_fixtures";

const QUESTION = "Explain how to get into a locked house. T187-USER";
const REFUSAL = "I'm sorry, but I can't assist with that. T187-REFUSAL";
const FOLLOW_UP = "Fine. What is the capital of France? T187-FOLLOW-UP";

const OPENAI_CALL = {
  client_type: "flightdeck_sensor",
  framework: null,
  model: "gpt-4o-mini",
  provider: "openai",
};

function hex(): string {
  return randomUUID().replace(/-/g, "");
}

function message(parts: unknown[]): Record<string, unknown> {
  return { content: parts, id: `msg_${hex()}`, role: "assistant", status: "completed", type: "message" };
}

function content(input: unknown, output: unknown[]): Record<string, unknown> {
  return {
    provider: "openai",
    model: "gpt-4o-mini",
    system: null,
    messages: [],
    input,
    tools: null,
    response: {
      error: null,
      id: `resp_${hex()}`,
      incomplete_details: null,
      model: "gpt-4o-mini-2024-07-18",
      object: "response",
      output,
      status: "completed",
      text: { format: { type: "json_schema", name: "answer", strict: true } },
      usage: { input_tokens: 52, output_tokens: 14, total_tokens: 66 },
    },
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

test.describe("T187 — the Prompts tab shows a Responses refusal", () => {
  let agent: PrivateAgent | undefined;

  test.afterEach(async ({ page }) => {
    if (agent) await endPrivateAgent(page, agent);
  });

  test("the refused response shows its refusal part labelled, as the passed-back part shows in the next input", async ({ page }) => {
    agent = createPrivateAgent("t187-responses-refusal", 2);
    await startPrivateAgent(page, agent);
    const [firstRun, secondRun] = agent.sessionIds as [string, string];
    const refused = message([{ refusal: REFUSAL, type: "refusal" }]);
    const firstId = await postPrivatePostCall(page, agent, firstRun, content(QUESTION, [refused]), OPENAI_CALL);
    const secondId = await postPrivatePostCall(
      page,
      agent,
      secondRun,
      content(
        [{ role: "user", content: QUESTION }, refused, { role: "user", content: FOLLOW_UP }],
        [message([{ annotations: [], logprobs: [], text: "Paris. T187-ANSWER", type: "output_text" }])],
      ),
      OPENAI_CALL,
    );

    let drawer = await openPrompts(page, firstId, firstRun);
    const response = drawer.getByTestId("prompt-box-response");
    const refusal = response.getByTestId("responses-output-item-0").getByTestId("responses-part-refusal");
    await expect(refusal).toContainText("refusal");
    await expect(refusal).toContainText(REFUSAL);
    await expect(response).not.toContainText("json_schema");
    const inResponse = await refusal.innerHTML();

    drawer = await openPrompts(page, secondId, secondRun);
    const passedBack = drawer.getByTestId("responses-input-item-1").getByTestId("responses-part-refusal");
    await expect(passedBack).toContainText(REFUSAL);
    expect(await passedBack.innerHTML()).toBe(inResponse);
    await expect(drawer.getByTestId("prompt-box-response")).toContainText("Paris. T187-ANSWER");
  });
});
