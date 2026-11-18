/**
 * T182 — The Prompts tab shows a Gemini function-calling round trip.
 *
 * Fixture: an agent of this spec run's own (``createPrivateAgent``) with
 * two runs, and on each one google-genai ``post_call`` posted through
 * ingestion in the sensor's wire shape with its content captured: the
 * two requests an automatic-function-calling round trip sends. Their
 * content is the request body the SDK built (``contents``, the
 * ``systemInstruction``'s parts, ``tools``) and the response body, as the
 * sensor stores them. Round one offers ``get_weather_t182`` and the model
 * answers with a ``functionCall``; round two sends the user's turn, the
 * model's call and the ``functionResponse``, and the model answers in
 * text. Opened in the event drawer, round one's tool box is named by the
 * function (not ``tool_0``) with its parameter, and its response shows
 * the call (the function's name, then ``city:`` and its value); round
 * two's turns carry their roles (``user``, ``model``, ``user``), the
 * model's turn shows the call, the user's reply is labelled ``function
 * response`` with the function it answers and its fields, and JSON keeps
 * the turn as stored (``functionResponse``).
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

const FUNCTION = "get_weather_t182";
const CITY = "Paris T182-CITY";
const RESULT = "sunny, 21 C T182-RESULT";
const ANSWER = "It is sunny in Paris. T182-ANSWER";
const QUESTION = "What is the weather in Paris? Use the tool. T182-USER";

/** The fields of the sensor's post_call for a Gemini call. */
const GEMINI_CALL = {
  client_type: "flightdeck_sensor",
  framework: null,
  model: "gemini-3.1-flash-lite",
  provider: "google",
};

const TOOLS = [
  {
    functionDeclarations: [
      {
        description: "Returns the current weather in a city.",
        name: FUNCTION,
        parameters_json_schema: {
          properties: { city: { type: "string" } },
          required: ["city"],
          type: "object",
        },
      },
    ],
  },
];

const USER_TURN = { parts: [{ text: QUESTION }], role: "user" };
const CALL_TURN = {
  parts: [{ functionCall: { args: { city: CITY }, id: "call_t182", name: FUNCTION }, thoughtSignature: "EpwBCpkBT182" }],
  role: "model",
};

function usage(prompt: number, candidates: number): Record<string, unknown> {
  return { promptTokenCount: prompt, candidatesTokenCount: candidates, totalTokenCount: prompt + candidates };
}

/** The content the sensor stores for a round: its request and response. */
function round(contents: unknown[], parts: unknown[]): Record<string, unknown> {
  return {
    provider: "google",
    model: "gemini-3.1-flash-lite",
    system: null,
    messages: [],
    tools: TOOLS,
    input: contents,
    response: {
      candidates: [{ content: { parts, role: "model" }, finishReason: "STOP", index: 0 }],
      modelVersion: "gemini-3.1-flash-lite",
      responseId: "t182",
      usageMetadata: usage(65, 16),
    },
    captured_at: new Date().toISOString(),
  };
}

test.describe("T182 — the Prompts tab shows a Gemini function-calling round trip", () => {
  let agent: PrivateAgent | undefined;

  test.afterEach(async ({ page }) => {
    if (agent) await endPrivateAgent(page, agent);
  });

  test("the function by its name, the model's call with its args and the function's response, named", async ({
    page,
  }) => {
    agent = createPrivateAgent("t182-gemini-function-calling", 2);
    await startPrivateAgent(page, agent);
    const [firstRun, secondRun] = agent.sessionIds as [string, string];
    const firstId = await postPrivatePostCall(page, agent, firstRun, round([USER_TURN], CALL_TURN.parts), GEMINI_CALL);
    const reply = { parts: [{ functionResponse: { name: FUNCTION, response: { result: RESULT } } }], role: "user" };
    const secondId = await postPrivatePostCall(
      page,
      agent,
      secondRun,
      round([USER_TURN, CALL_TURN, reply], [{ text: ANSWER }]),
      GEMINI_CALL,
    );

    // Round one: the tool by its name, the model's call in the response.
    await page.goto(`/events?event=${firstId}&event_session=${firstRun}`);
    const drawer = page.getByTestId("event-detail-drawer");
    await expect(drawer).toBeVisible();
    await drawer.getByTestId("detail-tab-prompts").click();
    await expect(drawer.getByTestId("prompt-viewer-gemini")).toBeVisible();
    const tool = drawer.getByTestId("prompt-box-tool-0");
    await expect(tool).toContainText(FUNCTION);
    await expect(tool).not.toContainText("tool_0");
    await expect(tool).toContainText("city");
    const call = drawer.getByTestId("prompt-box-response").getByTestId("content-block-tool-use");
    await expect(call).toContainText(FUNCTION);
    await expect(call.getByTestId("kv-label")).toHaveText(["city:"]);
    await expect(call).toContainText(CITY);
    await expect(drawer.getByTestId("prompt-box-content-0")).toContainText("T182-USER");

    // Round two: each turn with its role, the call, the named response.
    await page.goto(`/events?event=${secondId}&event_session=${secondRun}`);
    await expect(drawer).toBeVisible();
    await drawer.getByTestId("detail-tab-prompts").click();
    await expect(drawer.getByTestId("prompt-viewer-gemini")).toBeVisible();
    await expect(drawer.getByTestId("prompt-box-content-0")).toContainText("user");
    const modelTurn = drawer.getByTestId("prompt-box-content-1");
    await expect(modelTurn).toContainText("model");
    await expect(modelTurn.getByTestId("content-block-tool-use")).toContainText(FUNCTION);
    await expect(modelTurn.getByTestId("gemini-thought-signature")).toContainText("thoughtSignature");
    await expect(modelTurn).not.toContainText("EpwBCpkBT182");
    const response = drawer.getByTestId("prompt-box-content-2").getByTestId("gemini-function-response");
    await expect(response).toContainText("function response");
    await expect(response.getByTestId("tool-reply-target")).toHaveText(FUNCTION);
    await expect(response).toContainText(RESULT);
    await expect(drawer.getByTestId("prompt-box-response")).toContainText(ANSWER);

    // JSON keeps the turn as stored.
    await drawer.getByTestId("prompt-box-content-2-json").click();
    const raw = drawer.getByTestId("prompt-box-content-2-json-view");
    await expect(raw).toContainText('"functionResponse"');
    await expect(raw).toContainText(`"result": "${RESULT}"`);
    await expect(drawer.getByTestId("prompt-box-content-2").getByTestId("gemini-function-response")).toHaveCount(0);
  });
});
