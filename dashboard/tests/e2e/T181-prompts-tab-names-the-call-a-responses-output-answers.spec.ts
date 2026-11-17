/**
 * T181 — The Prompts tab names the function a Responses
 * ``function_call_output`` answers.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``), one
 * run, and on it one OpenAI Responses ``post_call`` posted through
 * ingestion in the sensor's wire shape with its content captured. Its
 * stored ``input`` is a tool-use loop as the provider received it: the
 * user's message, the ``function_call`` item the model made (``name``,
 * ``call_id``, ``arguments`` a JSON string) and the
 * ``function_call_output`` item answering that ``call_id``. Opened in the
 * event drawer, the ``function_call`` item shows the function's name, its
 * ``call_id`` and its arguments as fields; the output item is labelled
 * ``tool result`` with the name of the function it answers, keeps its
 * ``call_id`` line and shows its output; Raw keeps the item as stored.
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

const FUNCTION = "get_weather_t181";
const CITY = "Oslo T181-CITY";
const OUTPUT = "Snow, -3 C T181-OUTPUT";
const ANSWER = "It is snowing in Oslo. T181-RESPONSE";

/** The fields of the sensor's post_call for an OpenAI Responses call,
 *  over the private run's own. */
const OPENAI_CALL = {
  client_type: "flightdeck_sensor",
  framework: null,
  model: "gpt-4o-mini",
  provider: "openai",
};

/** The content the sensor stores for the loop's second call: the
 *  request's ``instructions`` in ``system`` and ``input`` verbatim. */
function loopContent(callId: string): Record<string, unknown> {
  return {
    provider: "openai",
    model: "gpt-4o-mini",
    system: "You are a weather assistant.",
    messages: [],
    input: [
      { role: "user", content: "What is the weather in Oslo? T181-USER" },
      {
        type: "function_call",
        id: `fc_${randomUUID().replace(/-/g, "")}`,
        call_id: callId,
        name: FUNCTION,
        arguments: JSON.stringify({ city: CITY }),
        status: "completed",
      },
      { type: "function_call_output", call_id: callId, output: OUTPUT },
    ],
    tools: [
      {
        type: "function",
        name: FUNCTION,
        description: "Current weather for a city",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    ],
    response: {
      id: `resp_${randomUUID().replace(/-/g, "")}`,
      object: "response",
      status: "completed",
      model: "gpt-4o-mini-2024-07-18",
      output: [
        {
          type: "message",
          id: `msg_${randomUUID().replace(/-/g, "")}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: ANSWER, annotations: [] }],
        },
      ],
      usage: { input_tokens: 90, output_tokens: 15, total_tokens: 105 },
    },
    captured_at: new Date().toISOString(),
  };
}

test.describe("T181 — the Prompts tab names the function a Responses output answers", () => {
  let agent: PrivateAgent | undefined;

  test.afterEach(async ({ page }) => {
    if (agent) await endPrivateAgent(page, agent);
  });

  test("the function_call shows its function and arguments, and the output names the function it answers", async ({
    page,
  }) => {
    agent = createPrivateAgent("t181-responses-tool-reply", 1);
    await startPrivateAgent(page, agent);
    const sessionId = agent.sessionIds[0]!;
    const callId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const eventId = await postPrivatePostCall(page, agent, sessionId, loopContent(callId), OPENAI_CALL);

    await page.goto(`/events?event=${eventId}&event_session=${sessionId}`);
    const drawer = page.getByTestId("event-detail-drawer");
    await expect(drawer).toBeVisible();
    await drawer.getByTestId("detail-tab-prompts").click();

    // The function_call item: the function's name, its call_id and the
    // arguments' key and value as a field.
    const callItem = drawer.getByTestId("responses-input-item-1");
    await expect(callItem).toHaveAttribute("data-item-type", "function_call");
    const call = callItem.getByTestId("responses-function-call");
    await expect(call).toContainText(FUNCTION);
    await expect(call.getByTestId("responses-call-id")).toHaveText(callId);
    await expect(call.getByTestId("kv-label")).toHaveText(["city:"]);
    await expect(call).toContainText(CITY);

    // The output item names the function it answers, keeps its call_id
    // line and shows its output.
    const outputItem = drawer.getByTestId("responses-input-item-2");
    await expect(outputItem).toHaveAttribute("data-item-type", "function_call_output");
    const output = outputItem.getByTestId("responses-function-call-output");
    await expect(output).toContainText("tool result");
    await expect(output.getByTestId("tool-reply-target")).toHaveText(FUNCTION);
    await expect(output.getByTestId("responses-call-id")).toHaveText(callId);
    await expect(output).toContainText(OUTPUT);

    // The rest of the call shows as it always has.
    await expect(drawer.getByTestId("prompt-box-instructions")).toContainText("You are a weather assistant.");
    await expect(drawer.getByTestId("responses-input-item-0")).toContainText("T181-USER");

    // Raw keeps the output item as stored.
    await drawer.getByTestId("prompt-box-input-2-raw").click();
    const raw = drawer.getByTestId("prompt-box-input-2-raw-json");
    await expect(raw).toContainText('"type": "function_call_output"');
    await expect(raw).toContainText(`"call_id": "${callId}"`);
    await expect(output).toHaveCount(0);
  });
});
