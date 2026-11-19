"""The real flightdeck_sensor on Gemini (google-genai), end to end.

``init()`` and ``patch()`` against the dev stack, the SDK's own
``genai.Client``, the Gemini API mocked at the HTTP boundary with respx:
sensor -> ingestion -> NATS -> workers -> database -> query API run for
real. A Gemini call lands with its provider, canonical model, tokens
(thinking and cached tokens included), cost and platform; its content,
in Gemini's own terms, is served by ``GET /v1/events/:id/content``, and
404 with capture off; each round of automatic function calling is a call.
An embeddings batch whose vectors do not fit the event keeps its
contents, the vectors stored as the size rule's marker.
"""

from __future__ import annotations

import contextlib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, Any

import pytest

pytest.importorskip("google.genai")

import flightdeck_sensor
import httpx
import respx
from google import genai
from google.genai import types

from .conftest import (
    API_URL,
    INGESTION_URL,
    TOKEN,
    auth_headers,
    delete_flavor_data,
    query_rows,
    wait_until,
)

if TYPE_CHECKING:
    from collections.abc import Iterator

# A model the vendored catalogue prices on the Gemini API.
MODEL = "gemini-3.1-flash-lite"
EMBED_MODEL = "gemini-embedding-001"
GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models"
PROMPT_MARKER = "gemini-e2e-prompt"
SYSTEM_MARKER = "gemini-e2e-system"
USAGE = {
    "promptTokenCount": 1000,
    "cachedContentTokenCount": 800,
    "candidatesTokenCount": 3,
    "thoughtsTokenCount": 148,
    "totalTokenCount": 1151,
}
# gemini-3.1-flash-lite on the Gemini API, USD per million tokens: input
# 0.25, cache read 0.025, output (and thinking) 1.5.
EXPECTED_COST = (200 * 0.25 + 800 * 0.025 + 151 * 1.5) / 1e6
# How long an event takes to reach the database through the stack.
LANDED_S = 20.0


def _answer_body(body: dict[str, Any]) -> dict[str, Any]:
    """The mock's answer to a ``generateContent`` request body: a function
    call while the request offers tools it has not answered, else text."""
    last = body["contents"][-1]
    answered = any("functionResponse" in p for p in last.get("parts", []))
    if body.get("tools") and not answered:
        parts: list[dict[str, Any]] = [
            {"functionCall": {"id": "call-1", "name": "get_weather", "args": {"city": "Paris"}}}
        ]
    else:
        parts = [{"text": "Hello from mock Gemini"}]
    return {
        "candidates": [{"content": {"role": "model", "parts": parts}, "finishReason": "STOP"}],
        "usageMetadata": USAGE,
        "modelVersion": MODEL,
        "responseId": "resp-e2e",
    }


def _answer(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    if request.url.path.endswith(":batchEmbedContents"):
        return httpx.Response(
            200, json={"embeddings": [{"values": [0.1, 0.2]} for _ in body["requests"]]}
        )
    return httpx.Response(
        200, headers={"x-gemini-service-tier": "standard"}, json=_answer_body(body)
    )


def _sent(router: respx.MockRouter) -> list[dict[str, Any]]:
    """The request bodies the mock Gemini API received, in order."""
    return [json.loads(call.request.content) for call in router.calls]


@pytest.fixture
def gemini() -> Iterator[respx.MockRouter]:
    with respx.mock(assert_all_called=False) as router:
        router.route(host="generativelanguage.googleapis.com").mock(side_effect=_answer)
        yield router


@pytest.fixture
def flavor() -> Iterator[str]:
    name = f"e2e-gemini-{uuid.uuid4().hex[:10]}"
    os.environ["AGENT_FLAVOR"] = name
    with contextlib.suppress(Exception):
        flightdeck_sensor.teardown()
    try:
        yield name
    finally:
        with contextlib.suppress(Exception):
            flightdeck_sensor.teardown()
        os.environ.pop("AGENT_FLAVOR", None)
        delete_flavor_data(name)


def _start(*, capture: bool) -> genai.Client:
    flightdeck_sensor.init(
        server=INGESTION_URL, token=TOKEN, capture_prompts=capture, agent_type="coding"
    )
    flightdeck_sensor.patch(quiet=True)
    return genai.Client(api_key="test-key")


def _events(flavor: str, event_type: str, least: int = 1) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []

    def _landed() -> bool:
        nonlocal found
        found = query_rows(
            "SELECT * FROM events WHERE flavor = :'flavor' AND event_type = :'kind' "
            "ORDER BY occurred_at",
            flavor=flavor,
            kind=event_type,
        )
        return len(found) >= least

    wait_until(_landed, timeout=LANDED_S, msg=f"fewer than {least} {event_type} for {flavor}")
    return found


def _content(event_id: str) -> dict[str, Any] | None:
    request = urllib.request.Request(
        f"{API_URL}/v1/events/{event_id}/content", headers=auth_headers()
    )
    try:
        with urllib.request.urlopen(request, timeout=5) as resp:
            body: dict[str, Any] = json.loads(resp.read())
            return body
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise


def _estimated_cost(flavor: str) -> float:
    now = datetime.now(UTC)
    params = {
        "metric": "estimated_cost",
        "group_by": "model",
        "range": "custom",
        "from": (now - timedelta(hours=1)).isoformat(),
        "to": (now + timedelta(minutes=5)).isoformat(),
        "granularity": "day",
        "filter_flavor": flavor,
    }
    request = urllib.request.Request(
        f"{API_URL}/v1/analytics?{urllib.parse.urlencode(params)}", headers=auth_headers()
    )
    with urllib.request.urlopen(request, timeout=10) as resp:
        total: float = json.loads(resp.read())["totals"]["grand_total"]
        return total


def test_a_gemini_call_lands_with_its_tokens_cost_and_content(
    gemini: respx.MockRouter, flavor: str
) -> None:
    client = _start(capture=True)
    client.models.generate_content(
        model=f"models/{MODEL}",
        contents=[types.Content(role="user", parts=[types.Part(text=PROMPT_MARKER)])],
        config=types.GenerateContentConfig(
            system_instruction=types.Content(parts=[types.Part(text=SYSTEM_MARKER)])
        ),
    )
    (post_call,) = _events(flavor, "post_call")
    assert post_call["model"] == MODEL
    assert post_call["model_requested"] == f"models/{MODEL}"
    assert post_call["model_served"] == MODEL
    assert post_call["provider"] == "google"
    assert post_call["platform"] == "gemini-api"
    assert post_call["billing_mode"] == "metered"
    assert (post_call["tokens_input"], post_call["tokens_output"]) == (1000, 151)
    assert (post_call["tokens_cache_read"], post_call["tokens_reasoning"]) == (800, 148)
    payload = post_call["payload"]
    assert (payload["stop_reason"], payload["service_tier"]) == ("STOP", "standard")
    assert _estimated_cost(flavor) == pytest.approx(EXPECTED_COST)

    content = _content(str(post_call["id"]))
    assert content is not None
    assert content["provider"] == "google"
    # The request body the SDK built, as the provider received it.
    sent = _sent(gemini)[0]
    assert content["input"] == sent["contents"]
    assert content["input"] == [{"parts": [{"text": PROMPT_MARKER}], "role": "user"}]
    # The system instruction's parts.
    assert content["system_prompt"] == sent["systemInstruction"]["parts"]
    assert content["system_prompt"] == [{"text": SYSTEM_MARKER}]
    # The response body as received.
    assert content["response"] == _answer_body(sent)
    candidate = content["response"]["candidates"][0]
    assert candidate["content"]["parts"] == [{"text": "Hello from mock Gemini"}]
    assert candidate["finishReason"] == "STOP"
    # The events row carries no content.
    assert PROMPT_MARKER not in json.dumps(payload)


def test_capture_off_serves_no_content(gemini: respx.MockRouter, flavor: str) -> None:
    client = _start(capture=False)
    client.models.generate_content(model=MODEL, contents=PROMPT_MARKER)
    (post_call,) = _events(flavor, "post_call")
    assert post_call["has_content"] is False
    assert _content(str(post_call["id"])) is None


def test_each_automatic_function_calling_round_lands_as_a_call(
    gemini: respx.MockRouter, flavor: str
) -> None:
    def get_weather(city: str) -> str:
        """The weather in a city."""
        return f"sunny in {city}"

    get_weather.__annotations__ = {"city": str, "return": str}
    client = _start(capture=True)
    client.models.generate_content(
        model=MODEL,
        contents="weather in Paris?",
        config=types.GenerateContentConfig(tools=[get_weather]),
    )
    post_calls = _events(flavor, "post_call", least=2)
    assert len(post_calls) == 2
    (tool_call,) = _events(flavor, "tool_call")
    assert tool_call["tool_name"] == "get_weather"
    second = _content(str(post_calls[1]["id"]))
    assert second is not None
    # Each round stores what that round sent.
    sent = _sent(gemini)
    assert second["input"] == sent[1]["contents"]
    roles = [c["role"] for c in second["input"]]
    assert roles == ["user", "model", "user"]
    assert "functionResponse" in second["input"][2]["parts"][0]
    assert second["tools"] == sent[1]["tools"]


def test_an_embeddings_call_lands(gemini: respx.MockRouter, flavor: str) -> None:
    client = _start(capture=True)
    client.models.embed_content(model=EMBED_MODEL, contents=["a", "b"])
    (event,) = _events(flavor, "embeddings")
    assert event["provider"] == "google"
    assert event["model"] == EMBED_MODEL
    content = _content(str(event["id"]))
    assert content is not None
    # Each batched request's content, as sent.
    assert content["input"] == [r["content"] for r in _sent(gemini)[0]["requests"]]
    assert content["input"][0] == {"parts": [{"text": "a"}], "role": "user"}


# google-genai's default dimension for gemini-embedding-001. Twelve
# vectors of the long floats below are over the 768 KiB event body limit
# on their own (the API's own values are shorter: about 19 vectors).
DEFAULT_DIMENSION = 3072
VECTORS_MARKER = re.compile(r"… \[flightdeck: kept 0 of (\d+) bytes to fit the event size limit\]")


def _full_size_vectors(request: httpx.Request) -> httpx.Response:
    count = len(json.loads(request.content)["requests"])
    values = [
        [((i * 7919 + j) % 2001 - 1000) / 9973 for j in range(DEFAULT_DIMENSION)]
        for i in range(count)
    ]
    return httpx.Response(200, json={"embeddings": [{"values": v} for v in values]})


def test_an_embeddings_batch_whose_vectors_do_not_fit_lands_with_its_contents(
    flavor: str,
) -> None:
    """The vectors give way to the size rule's marker, which
    ``event_content.embedding_output`` stores in their place, a JSON
    string; the contents arrive whole."""
    texts = [f"text {i}: " + "lorem ipsum dolor sit amet " * 8 for i in range(12)]
    with respx.mock(assert_all_called=False) as router:
        router.route(host="generativelanguage.googleapis.com").mock(side_effect=_full_size_vectors)
        client = _start(capture=True)
        reply = client.models.embed_content(model=EMBED_MODEL, contents=texts)
        # The router forgets its calls when the mock ends.
        (sent,) = _sent(router)
    assert reply.embeddings is not None
    vectors = [list(e.values or []) for e in reply.embeddings]
    (event,) = _events(flavor, "embeddings")
    assert event["has_content"] is True
    assert event["payload"]["output_dimensions"] == {"count": 12, "dimension": DEFAULT_DIMENSION}
    content = _content(str(event["id"]))
    assert content is not None
    assert content["input"] == [r["content"] for r in sent["requests"]]
    assert [c["parts"][0]["text"] for c in content["input"]] == texts
    (row,) = query_rows(
        "SELECT embedding_output FROM event_content WHERE event_id = :'event_id'",
        event_id=str(event["id"]),
    )
    marker = row["embedding_output"]
    assert isinstance(marker, str)
    match = VECTORS_MARKER.fullmatch(marker)
    assert match, marker
    assert int(match.group(1)) == len(json.dumps(vectors).encode())
