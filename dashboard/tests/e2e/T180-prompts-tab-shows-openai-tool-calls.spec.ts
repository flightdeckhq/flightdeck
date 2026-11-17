/**
 * T180 — The Prompts tab shows an OpenAI call's tool calls.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``), one
 * run, and on it one OpenAI chat ``post_call`` posted through ingestion
 * in the sensor's wire shape with its content captured. Its stored
 * messages are a tool-use loop as the provider received it: the user's
 * question, the assistant message that called a tool (``content: null``
 * and a ``tool_calls`` entry whose ``arguments`` is a JSON string, the
 * SDK's message dumped whole), and the ``tool`` reply naming that call's
 * id. Opened in the event drawer, the assistant's box shows the call (the
 * tool's name, then its arguments as labelled fields) instead of
 * ``(empty)``, the reply is labelled ``tool result`` with the name of the
 * tool it answers, and Raw keeps the message as stored, ``arguments``
 * still a string.
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

const TOOL = "get_weather_t180";
const CITY = "Paris T180-CITY";
const REPLY = "Sunny, 21 C T180-REPLY";
const ANSWER = "It is sunny in Paris. T180-RESPONSE";

/** The fields of the sensor's post_call for an OpenAI chat call, over
 *  the private run's own. */
const OPENAI_CALL = {
  client_type: "flightdeck_sensor",
  framework: null,
  model: "gpt-4o-mini",
  provider: "openai",
};

/** The content the sensor stores for the loop's second call. */
function loopContent(callId: string): Record<string, unknown> {
  return {
    provider: "openai",
    model: "gpt-4o-mini",
    system: null,
    messages: [
      { role: "user", content: "What is the weather in Paris? Use the tool. T180-USER" },
      {
        role: "assistant",
        content: null,
        refusal: null,
        annotations: [],
        tool_calls: [
          { id: callId, type: "function", function: { name: TOOL, arguments: JSON.stringify({ city: CITY }) } },
        ],
      },
      { role: "tool", tool_call_id: callId, content: REPLY },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: TOOL,
          description: "Current weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ],
    response: {
      object: "chat.completion",
      model: "gpt-4o-mini-2024-07-18",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: ANSWER, tool_calls: null, function_call: null, refusal: null },
        },
      ],
      usage: { prompt_tokens: 90, completion_tokens: 15, total_tokens: 105 },
    },
    captured_at: new Date().toISOString(),
  };
}

test.describe("T180 — the Prompts tab shows an OpenAI call's tool calls", () => {
  let agent: PrivateAgent | undefined;

  test.afterEach(async ({ page }) => {
    if (agent) await endPrivateAgent(page, agent);
  });

  test("the assistant's call shows its tool and arguments, and the reply names the tool it answers", async ({
    page,
  }) => {
    agent = createPrivateAgent("t180-openai-tool-calls", 1);
    await startPrivateAgent(page, agent);
    const sessionId = agent.sessionIds[0]!;
    const callId = `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const eventId = await postPrivatePostCall(page, agent, sessionId, loopContent(callId), OPENAI_CALL);

    await page.goto(`/events?event=${eventId}&event_session=${sessionId}`);
    const drawer = page.getByTestId("event-detail-drawer");
    await expect(drawer).toBeVisible();
    await drawer.getByTestId("detail-tab-prompts").click();

    // The assistant message shows its call: the tool's name, then the
    // arguments' key and value as a field.
    const assistant = drawer.getByTestId("prompt-box-message-1");
    const call = assistant.getByTestId("content-block-tool-use");
    await expect(call).toHaveCount(1);
    await expect(call).toContainText(TOOL);
    await expect(call.getByTestId("kv-label")).toHaveText(["city:"]);
    await expect(call).toContainText(CITY);
    await expect(assistant).not.toContainText("(empty)");

    // The reply says which call it answers, by the tool's name.
    const reply = drawer.getByTestId("prompt-box-message-2").getByTestId("chat-tool-reply");
    await expect(reply.getByTestId("tool-reply-target")).toHaveText(TOOL);
    await expect(reply).toContainText("tool result");
    await expect(reply).toContainText(REPLY);

    // The rest of the call shows as it always has.
    await expect(drawer.getByTestId("prompt-box-message-0")).toContainText("T180-USER");
    await expect(drawer.getByTestId("prompt-box-response")).toContainText(ANSWER);

    // Raw keeps the assistant message as stored: arguments a string.
    await drawer.getByTestId("prompt-box-message-1-raw").click();
    const raw = drawer.getByTestId("prompt-box-message-1-raw-json");
    await expect(raw).toContainText('"content": null');
    await expect(raw).toContainText(`"arguments": "{\\"city\\":\\"${CITY}\\"}"`);
    await expect(raw).toContainText(`"id": "${callId}"`);
    await expect(assistant.getByTestId("content-block-tool-use")).toHaveCount(0);
  });
});
