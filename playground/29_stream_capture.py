"""Streamed calls store their response and report their tool calls, on
every streaming path of the Anthropic and OpenAI SDKs.

One small real stream per path, then a read-back from the API:

* Anthropic ``messages.create(stream=True)`` with a forced tool.
* OpenAI ``chat.completions.create(stream=True)`` with a forced tool.
* OpenAI ``responses.create(stream=True)`` with ``instructions``, ``input``
  and a forced tool.
* OpenAI ``chat.completions.stream()`` and ``responses.stream()`` helpers.
* OpenAI ``with_raw_response.create(stream=True)`` on chat and Responses.
* OpenAI ``with_streaming_response.create(stream=True)`` on chat and
  Responses.
* OpenAI Responses with a hosted MCP tool (OpenAI's public DeepWiki MCP
  server): the ``mcp_call`` lands as a ``tool_call`` naming the server as
  ``server_name``. Skipped, not failed, when that server is unavailable.

Each path must land one ``post_call`` with a ``streaming`` block and real
token counts, and (capture on) stored content whose response holds the
streamed text or tool call; a forced tool must land its ``tool_call``.
Self-skips (exit 2) when a provider key is missing.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections.abc import Callable
from typing import Any

try:
    import anthropic
    import openai
except ImportError:
    print("SKIP: pip install anthropic openai to run this example")
    sys.exit(2)

import flightdeck_sensor
from _helpers import (
    API_TOKEN,
    API_URL,
    fetch_events_for_session,
    init_sensor,
    print_result,
)

FLAVOR = "playground-stream-capture"
ANTHROPIC_MODEL = "claude-haiku-4-5"
OPENAI_MODEL = "gpt-4o-mini"
# Small enough to keep each call to a few cents' fraction, large enough
# for a forced tool call's arguments (Responses' floor is 16).
MAX_TOKENS = 40
WEATHER_SCHEMA = {
    "type": "object",
    "properties": {"city": {"type": "string"}},
    "required": ["city"],
    "additionalProperties": False,
}
SAY_HI = "Reply with the single word hi."
# OpenAI's public, unauthenticated DeepWiki MCP server, the one OpenAI's
# own remote-MCP docs use.
DEEPWIKI_MCP = {
    "type": "mcp",
    "server_label": "deepwiki",
    "server_url": "https://mcp.deepwiki.com/mcp",
    "require_approval": "never",
    "allowed_tools": ["read_wiki_structure"],
}
# How long to wait for every post_call and tool_call to land after
# teardown: the drain flush plus the worker batch.
EVENTS_DEADLINE_S = 30.0


def _drain(stream: Any) -> None:
    for _ in stream:
        pass


def _content(event_id: str) -> tuple[int, dict[str, Any]]:
    req = urllib.request.Request(
        f"{API_URL}/v1/events/{event_id}/content",
        headers={"Authorization": f"Bearer {API_TOKEN}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        return exc.code, {}


def _response_text(response: dict[str, Any]) -> str:
    """The streamed text or tool call held by a stored response, in each
    provider's own shape."""
    parts: list[str] = []
    for block in response.get("content") or []:  # Anthropic
        if block.get("type") == "text":
            parts.append(block.get("text") or "")
        elif block.get("type") == "tool_use":
            parts.append(
                f"tool_use {block.get('name')}({json.dumps(block.get('input'))})"
            )
    for choice in response.get("choices") or []:  # OpenAI chat
        message = choice.get("message") or {}
        if message.get("content"):
            parts.append(message["content"])
        for call in message.get("tool_calls") or []:
            fn = call.get("function") or {}
            parts.append(f"tool_call {fn.get('name')}({fn.get('arguments')})")
    for item in response.get("output") or []:  # OpenAI Responses
        if item.get("type") == "message":
            parts.extend(c.get("text") or "" for c in item.get("content") or [])
        elif item.get("type") in ("function_call", "mcp_call"):
            parts.append(f"{item['type']} {item.get('name')}({item.get('arguments')})")
    return " | ".join(p.strip() for p in parts if p)


def main() -> None:
    have_anthropic = bool(os.environ.get("ANTHROPIC_API_KEY"))
    have_openai = bool(os.environ.get("OPENAI_API_KEY"))
    if not (have_anthropic and have_openai):
        print(
            "SKIP: this script requires ANTHROPIC_API_KEY and OPENAI_API_KEY",
            file=sys.stderr,
        )
        sys.exit(2)

    session_id = str(uuid.uuid4())
    init_sensor(session_id, flavor=FLAVOR)
    flightdeck_sensor.patch(quiet=True)
    claude = anthropic.Anthropic()
    gpt = openai.OpenAI()

    chat_tool = {
        "type": "function",
        "function": {
            "name": "get_weather",
            "parameters": WEATHER_SCHEMA,
            "strict": True,
        },
    }
    responses_tool = {
        "type": "function",
        "name": "get_weather",
        "parameters": WEATHER_SCHEMA,
        "strict": True,
    }
    weather_q = [{"role": "user", "content": "Weather in Paris? Use the tool."}]

    # (label, run, expects a tool_call, expected server_name)
    paths: list[tuple[str, Callable[[], None], bool, str | None]] = [
        (
            "anthropic messages.create(stream=True)",
            lambda: _drain(
                claude.messages.create(
                    model=ANTHROPIC_MODEL,
                    max_tokens=MAX_TOKENS + 40,
                    messages=weather_q,
                    tools=[
                        {
                            "name": "get_weather",
                            "description": "Weather for a city",
                            "input_schema": WEATHER_SCHEMA,
                        }
                    ],
                    tool_choice={"type": "tool", "name": "get_weather"},
                    stream=True,
                )
            ),
            True,
            None,
        ),
        (
            "openai chat.completions.create(stream=True)",
            lambda: _drain(
                gpt.chat.completions.create(
                    model=OPENAI_MODEL,
                    max_completion_tokens=MAX_TOKENS,
                    messages=weather_q,
                    tools=[chat_tool],
                    tool_choice="required",
                    stream=True,
                )
            ),
            True,
            None,
        ),
        (
            "openai responses.create(stream=True)",
            lambda: _drain(
                gpt.responses.create(
                    model=OPENAI_MODEL,
                    max_output_tokens=MAX_TOKENS,
                    instructions="You answer weather questions with the tool.",
                    input="Weather in Paris?",
                    tools=[responses_tool],
                    tool_choice="required",
                    stream=True,
                )
            ),
            True,
            None,
        ),
    ]

    def chat_helper() -> None:
        with gpt.chat.completions.stream(
            model=OPENAI_MODEL,
            max_completion_tokens=MAX_TOKENS,
            messages=[{"role": "user", "content": SAY_HI}],
        ) as stream:
            stream.get_final_completion()

    def responses_helper() -> None:
        with gpt.responses.stream(
            model=OPENAI_MODEL, max_output_tokens=MAX_TOKENS, input=SAY_HI
        ) as stream:
            stream.get_final_response()

    def chat_raw() -> None:
        raw = gpt.chat.completions.with_raw_response.create(
            model=OPENAI_MODEL,
            max_completion_tokens=MAX_TOKENS,
            messages=[{"role": "user", "content": SAY_HI}],
            stream=True,
        )
        with raw.parse() as stream:
            _drain(stream)

    def responses_raw() -> None:
        raw = gpt.responses.with_raw_response.create(
            model=OPENAI_MODEL, max_output_tokens=MAX_TOKENS, input=SAY_HI, stream=True
        )
        _drain(raw.parse())

    def chat_streaming_view() -> None:
        with gpt.chat.completions.with_streaming_response.create(
            model=OPENAI_MODEL,
            max_completion_tokens=MAX_TOKENS,
            messages=[{"role": "user", "content": SAY_HI}],
            stream=True,
        ) as response:
            _drain(response.parse())

    def responses_streaming_view() -> None:
        with gpt.responses.with_streaming_response.create(
            model=OPENAI_MODEL, max_output_tokens=MAX_TOKENS, input=SAY_HI, stream=True
        ) as response:
            _drain(response.parse())

    paths += [
        ("openai chat.completions.stream()", chat_helper, False, None),
        ("openai responses.stream()", responses_helper, False, None),
        ("openai chat with_raw_response(stream=True)", chat_raw, False, None),
        ("openai responses with_raw_response(stream=True)", responses_raw, False, None),
        (
            "openai chat with_streaming_response(stream=True)",
            chat_streaming_view,
            False,
            None,
        ),
        (
            "openai responses with_streaming_response(stream=True)",
            responses_streaming_view,
            False,
            None,
        ),
    ]

    def responses_mcp() -> None:
        _drain(
            gpt.responses.create(
                model=OPENAI_MODEL,
                max_output_tokens=MAX_TOKENS,
                input=(
                    "Call read_wiki_structure for the repo openai/openai-python, "
                    "then reply OK."
                ),
                tools=[DEEPWIKI_MCP],
                tool_choice="required",
                stream=True,
            )
        )

    ran: list[tuple[str, bool, str | None]] = []
    failures: list[str] = []
    for label, run, expects_tool, server in paths:
        t0 = time.monotonic()
        try:
            run()
            ran.append((label, expects_tool, server))
            print_result(label, True, int((time.monotonic() - t0) * 1000), "streamed")
        except (anthropic.APIError, openai.APIError) as exc:
            failures.append(f"{label}: {type(exc).__name__}: {exc}")
            print_result(
                label, False, int((time.monotonic() - t0) * 1000), type(exc).__name__
            )

    t0 = time.monotonic()
    try:
        responses_mcp()
        ran.append(("openai responses hosted MCP (stream=True)", True, "deepwiki"))
        print_result(
            "openai responses hosted MCP", True, int((time.monotonic() - t0) * 1000)
        )
    except openai.APIError as exc:
        # The public MCP server being down is not a sensor failure.
        print(f"  SKIP  openai responses hosted MCP: {type(exc).__name__}: {exc}")

    flightdeck_sensor.teardown()

    want_tools = sum(1 for _, expects, _ in ran if expects)
    deadline = time.monotonic() + EVENTS_DEADLINE_S
    events: list[dict[str, Any]] = []
    while time.monotonic() < deadline:
        events = fetch_events_for_session(
            session_id, expect_event_types=["post_call"], timeout_s=5
        )
        post_calls = [e for e in events if e.get("event_type") == "post_call"]
        tool_calls = [e for e in events if e.get("event_type") == "tool_call"]
        if len(post_calls) >= len(ran) and len(tool_calls) >= want_tools:
            break
        time.sleep(1)
    events.sort(key=lambda e: e.get("occurred_at") or "")
    post_calls = [e for e in events if e.get("event_type") == "post_call"]
    tool_calls = [e for e in events if e.get("event_type") == "tool_call"]

    print(
        f"\nsession {session_id}: {len(post_calls)} post_call, {len(tool_calls)} tool_call"
    )
    if len(post_calls) != len(ran):
        failures.append(f"expected {len(ran)} post_calls, got {len(post_calls)}")
    for (label, _, _), pc in zip(ran, post_calls):
        streaming = (pc.get("payload") or {}).get("streaming") or {}
        status, content = _content(pc["id"])
        text = _response_text(content.get("response") or {}) if status == 200 else ""
        print(
            f"  {label}\n"
            f"    tokens in/out {pc.get('tokens_input')}/{pc.get('tokens_output')}"
            f"  outcome={streaming.get('final_outcome')} chunks={streaming.get('chunk_count')}"
            f"  content={status}\n"
            f"    response: {text[:160]!r}"
        )
        if content.get("input") is not None or content.get("system_prompt"):
            print(
                f"    request: system={content.get('system_prompt')!r} "
                f"input={json.dumps(content.get('input'))[:80]}"
            )
        if not streaming or streaming.get("final_outcome") != "completed":
            failures.append(f"{label}: no completed streaming block ({streaming})")
        if not (pc.get("tokens_output") or 0) > 0:
            failures.append(f"{label}: no output tokens")
        if status != 200 or not text:
            failures.append(f"{label}: no stored response (content {status})")
    for tc in tool_calls:
        server = (tc.get("payload") or {}).get("server_name")
        status, content = _content(tc["id"])
        print(
            f"  tool_call {tc.get('tool_name')} server_name={server!r} "
            f"input={json.dumps(content.get('tool_input'))[:80]} (content {status})"
        )
    if len(tool_calls) < want_tools:
        failures.append(f"expected {want_tools} tool_calls, got {len(tool_calls)}")
    servers = {(tc.get("payload") or {}).get("server_name") for tc in tool_calls}
    for _, _, server in ran:
        if server is not None and server not in servers:
            failures.append(f"no tool_call carries server_name={server!r}")

    if failures:
        raise AssertionError("; ".join(failures))
    print(
        "\nPASS: every streaming path stored its response and reported its tool calls"
    )


if __name__ == "__main__":
    main()
