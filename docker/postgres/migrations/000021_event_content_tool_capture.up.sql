-- D150 (Phase 7 Step 3.b): event_content gains dedicated tool_input
-- + tool_output jsonb columns so MCP tool capture (mcp_tool_call,
-- mcp_prompt_get) and LLM-side tool_call (Anthropic / OpenAI
-- function-calling responses) can route arguments + results through
-- event_content instead of inline events.payload. Matches the
-- LLM-prompt capture posture (D-PHASE1) — content lives in
-- event_content, fetched on demand via GET /v1/events/:id/content;
-- events.payload stays lean (Phase 5 D2 invariant).
--
-- Hard cutover per pre-v0.6 no-compat-tax — sensor + plugin +
-- worker ship together. Inline ``arguments`` / ``result`` on the
-- mcp_tool_call payload + inline ``tool_input`` / ``tool_result``
-- on the events row for LLM tool_call are removed by the same
-- commit. Operators run ``make dev-reset`` to apply.
--
-- ``mcp_resource_read`` body capture stays on the existing inline-
-- vs-overflow path (Q1 lock). Resource bodies are blobs, not
-- request/response shapes; the dedicated columns are reserved for
-- the request/response semantic. A future ``resource_content``
-- column would be a separate D-numbered decision.

ALTER TABLE event_content
    ADD COLUMN tool_input  jsonb,
    ADD COLUMN tool_output jsonb;

COMMENT ON COLUMN event_content.tool_input IS
    'D150: tool args / prompt arguments. Populated on mcp_tool_call '
    '(arguments parameter), mcp_prompt_get (prompt arguments), and '
    'LLM-side tool_call (function-calling tool_input). NULL when '
    'capture is off or the event type is not a tool/prompt call.';

COMMENT ON COLUMN event_content.tool_output IS
    'D150: tool / prompt results. Populated on mcp_tool_call (result), '
    'mcp_prompt_get (rendered messages), and LLM-side tool_call '
    '(tool_result, retroactively populated when the next assistant '
    'turn shows the output). NULL when capture is off, the call '
    'errored, or the event type is not a tool/prompt call.';
