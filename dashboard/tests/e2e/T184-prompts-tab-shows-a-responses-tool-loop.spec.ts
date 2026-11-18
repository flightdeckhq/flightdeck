/**
 * T184 — The Prompts tab shows an OpenAI Responses tool loop, both calls.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``), two
 * runs, and on each one OpenAI Responses ``post_call`` posted through
 * ingestion in the sensor's wire shape with its content captured: the
 * loop's first call, whose response's output is the ``function_call``
 * item the model made, and its second, whose input passes that item back
 * with its ``function_call_output`` and whose response's output is the
 * answer message. Opened in the event drawer, the first call's response
 * shows the call (the function's name, its ``call_id``, its arguments as
 * fields), not the response object, with the token line; the second
 * call's input shows the same item the same way, and its response shows
 * the answer's text. Raw keeps the response as stored.
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

const FUNCTION = "get_weather_t184";
const CITY = "Lisbon T184-CITY";
const OUTPUT = "Sunny, 24 C T184-OUTPUT";
const ANSWER = "It is sunny in Lisbon. T184-ANSWER";
const QUESTION = "What is the weather in Lisbon? T184-USER";

const OPENAI_CALL = {
  client_type: "flightdeck_sensor",
  framework: null,
  model: "gpt-4o-mini",
  provider: "openai",
};

const TOOLS = [
  {
    type: "function",
    name: FUNCTION,
    description: "Current weather for a city",
    parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    strict: true,
  },
];

function hex(): string {
  return randomUUID().replace(/-/g, "");
}

/** The function_call item the model made, as the API returns it. */
function functionCall(callId: string): Record<string, unknown> {
  return {
    arguments: JSON.stringify({ city: CITY }),
    call_id: callId,
    id: `fc_${hex()}`,
    name: FUNCTION,
    status: "completed",
    type: "function_call",
  };
}

/** A stored Responses response: the API's response object, its
 *  settings and billing beside the output. */
function response(output: unknown[], usage: Record<string, number>): Record<string, unknown> {
  return {
    access_programs: null,
    billing: { payer: "developer" },
    error: null,
    id: `resp_${hex()}`,
    incomplete_details: null,
    model: "gpt-4o-mini-2024-07-18",
    object: "response",
    output,
    parallel_tool_calls: true,
    status: "completed",
    usage: { ...usage, total_tokens: usage.input_tokens! + usage.output_tokens! },
  };
}

function firstCall(callId: string): Record<string, unknown> {
  return {
    provider: "openai",
    model: "gpt-4o-mini",
    system: "You are a weather assistant.",
    messages: [],
    input: [{ role: "user", content: QUESTION }],
    tools: TOOLS,
    response: response([functionCall(callId)], { input_tokens: 61, output_tokens: 17 }),
    captured_at: new Date().toISOString(),
  };
}

function secondCall(callId: string, item: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: "openai",
    model: "gpt-4o-mini",
    system: "You are a weather assistant.",
    messages: [],
    input: [{ role: "user", content: QUESTION }, item, { type: "function_call_output", call_id: callId, output: OUTPUT }],
    tools: TOOLS,
    response: response(
      [
        {
          content: [{ annotations: [], logprobs: [], text: ANSWER, type: "output_text" }],
          id: `msg_${hex()}`,
          role: "assistant",
          status: "completed",
          type: "message",
        },
      ],
      { input_tokens: 95, output_tokens: 12 },
    ),
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

test.describe("T184 — the Prompts tab shows a Responses tool loop", () => {
  let agent: PrivateAgent | undefined;

  test.afterEach(async ({ page }) => {
    if (agent) await endPrivateAgent(page, agent);
  });

  test("the first call's response shows the function call; the second shows it passed back and the answer", async ({ page }) => {
    agent = createPrivateAgent("t184-responses-tool-loop", 2);
    await startPrivateAgent(page, agent);
    const [firstRun, secondRun] = agent.sessionIds as [string, string];
    const callId = `call_${hex().slice(0, 24)}`;
    const first = firstCall(callId);
    const item = (first.response as { output: Record<string, unknown>[] }).output[0]!;
    const firstId = await postPrivatePostCall(page, agent, firstRun, first, OPENAI_CALL);
    const secondId = await postPrivatePostCall(page, agent, secondRun, secondCall(callId, item), OPENAI_CALL);

    // The first call: the response is the function call, not the object.
    let drawer = await openPrompts(page, firstId, firstRun);
    const response = drawer.getByTestId("prompt-box-response");
    const outputItem = response.getByTestId("responses-output-item-0");
    await expect(outputItem).toHaveAttribute("data-item-type", "function_call");
    const call = outputItem.getByTestId("responses-function-call");
    await expect(call).toContainText(FUNCTION);
    await expect(call.getByTestId("responses-call-id")).toHaveText(callId);
    await expect(call.getByTestId("kv-label")).toHaveText(["city:"]);
    await expect(call).toContainText(CITY);
    await expect(response).not.toContainText("access_programs");
    await expect(response).toContainText("Tokens in: 61 · Tokens out: 17");
    const responseCall = await call.innerHTML();

    // Raw keeps the response as stored.
    await drawer.getByTestId("prompt-box-response-raw").click();
    const raw = drawer.getByTestId("prompt-box-response-raw-json");
    await expect(raw).toContainText('"access_programs": null');
    await expect(raw).toContainText(`"call_id": "${callId}"`);

    // The second call: the same item in the input, then the answer.
    drawer = await openPrompts(page, secondId, secondRun);
    const passedBack = drawer.getByTestId("responses-input-item-1").getByTestId("responses-function-call");
    await expect(passedBack).toContainText(FUNCTION);
    expect(await passedBack.innerHTML()).toBe(responseCall);
    const answer = drawer.getByTestId("prompt-box-response").getByTestId("responses-output-item-0");
    await expect(answer).toHaveAttribute("data-item-type", "message");
    await expect(answer).toContainText(ANSWER);
    await expect(drawer.getByTestId("prompt-box-response")).toContainText("Tokens in: 95 · Tokens out: 12");
  });
});
