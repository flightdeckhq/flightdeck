/**
 * T185 — The Prompts tab shows a reasoning model's Responses response.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``), one
 * run, and on it one OpenAI Responses ``post_call`` posted through
 * ingestion in the sensor's wire shape with its content captured: a
 * reasoning model's answer, whose output is a ``reasoning`` item (its
 * summary, and its ``encrypted_content``, which a caller that keeps no
 * state at OpenAI asks for) and the answer message. Opened in the event
 * drawer, the response shows the reasoning labelled ``reasoning`` with
 * its summary, a mark that the encrypted content is in the JSON view
 * (the content itself not shown), then the answer and the token line;
 * the JSON view keeps the encrypted content as stored.
 *
 * Theme-agnostic: test ids and text only, so it runs under both the
 * neon-dark and clean-light theme projects (Rule 40c.3).
 */
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import {
  createPrivateAgent,
  endPrivateAgent,
  postPrivatePostCall,
  startPrivateAgent,
  type PrivateAgent,
} from "./_fixtures";

const SUMMARY = "**Checking 391** It is 17 times 23, so it is not prime. T185-SUMMARY";
const ANSWER = "No. T185-ANSWER";
const ENCRYPTED = `gAAAAABT185${"x".repeat(600)}`;

const OPENAI_CALL = {
  client_type: "flightdeck_sensor",
  framework: null,
  model: "gpt-5-mini",
  provider: "openai",
};

function hex(): string {
  return randomUUID().replace(/-/g, "");
}

function reasoningContent(): Record<string, unknown> {
  return {
    provider: "openai",
    model: "gpt-5-mini",
    system: null,
    messages: [],
    input: "Is 391 a prime number? Answer yes or no. T185-USER",
    tools: null,
    response: {
      error: null,
      id: `resp_${hex()}`,
      incomplete_details: null,
      model: "gpt-5-mini-2025-08-07",
      object: "response",
      output: [
        {
          content: [],
          encrypted_content: ENCRYPTED,
          id: `rs_${hex()}`,
          summary: [{ text: SUMMARY, type: "summary_text" }],
          type: "reasoning",
        },
        {
          content: [{ annotations: [], logprobs: [], text: ANSWER, type: "output_text" }],
          id: `msg_${hex()}`,
          role: "assistant",
          status: "completed",
          type: "message",
        },
      ],
      reasoning: { effort: "low", summary: "auto" },
      status: "completed",
      store: false,
      usage: { input_tokens: 17, output_tokens: 59, output_tokens_details: { reasoning_tokens: 48 }, total_tokens: 76 },
    },
    captured_at: new Date().toISOString(),
  };
}

test.describe("T185 — the Prompts tab shows a Responses reasoning response", () => {
  let agent: PrivateAgent | undefined;

  test.afterEach(async ({ page }) => {
    if (agent) await endPrivateAgent(page, agent);
  });

  test("the reasoning shows its summary and marks its encrypted content, then the answer", async ({ page }) => {
    agent = createPrivateAgent("t185-responses-reasoning", 1);
    await startPrivateAgent(page, agent);
    const sessionId = agent.sessionIds[0]!;
    const eventId = await postPrivatePostCall(page, agent, sessionId, reasoningContent(), OPENAI_CALL);

    await page.goto(`/events?event=${eventId}&event_session=${sessionId}`);
    const drawer = page.getByTestId("event-detail-drawer");
    await expect(drawer).toBeVisible();
    await drawer.getByTestId("detail-tab-prompts").click();

    const response = drawer.getByTestId("prompt-box-response");
    const reasoning = response.getByTestId("responses-output-item-0").getByTestId("responses-reasoning-item");
    await expect(reasoning).toContainText("reasoning");
    await expect(reasoning.getByTestId("responses-reasoning")).toContainText(SUMMARY);
    await expect(reasoning.getByTestId("responses-encrypted-reasoning")).toHaveText(
      "encrypted_content · encrypted reasoning, in JSON",
    );
    await expect(response).not.toContainText("gAAAAABT185");
    const answer = response.getByTestId("responses-output-item-1");
    await expect(answer).toHaveAttribute("data-item-type", "message");
    await expect(answer).toContainText(ANSWER);
    await expect(response).toContainText("Tokens in: 17 · Tokens out: 59");
    await expect(response.getByTestId("responses-status")).toHaveCount(0);

    // The JSON view keeps the encrypted content as stored.
    await drawer.getByTestId("prompt-box-response-json").click();
    await expect(drawer.getByTestId("prompt-box-response-json-view")).toContainText("gAAAAABT185");
  });
});
