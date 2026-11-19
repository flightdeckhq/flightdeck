"""An embeddings call whose vectors take its event over the size limit
keeps its input whole: the vectors give way to the size rule's marker.

From about 25 texts at OpenAI's default of 1536 dimensions (about 19 at
google-genai's default of 3072, whose values are shorter) the vectors
alone pass the 768 KiB limit, and no string cut shortens them. The
vectors here are float32 values written in full, so 12 at 3072 already
pass it. Driven with the real ``openai`` client, litellm over it and
google-genai's ``genai.Client`` at the HTTP boundary; each event is
serialised as the transport sends it (``serialize_event``).
"""

from __future__ import annotations

import base64
import json
import struct
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import httpx
import openai
import pytest
import respx

import flightdeck_sensor
from flightdeck_sensor.core.policy import PolicyCache
from flightdeck_sensor.core.session import Session
from flightdeck_sensor.core.types import SensorConfig
from flightdeck_sensor.interceptor.openai import patch_openai_classes, unpatch_openai_classes
from flightdeck_sensor.transport.body_limit import (
    MAX_EVENT_BODY_BYTES,
    encoded_size,
    serialize_event,
    truncation_marker,
)
from flightdeck_sensor.transport.client import ControlPlaneClient

if TYPE_CHECKING:
    from collections.abc import Iterator

MODEL = "text-embedding-3-small"
GEMINI_MODEL = "gemini-embedding-001"
TEXTS = [f"text {i}: " + "lorem ipsum dolor sit amet " * 8 for i in range(30)]


def _vector(dimension: int, seed: int) -> list[float]:
    # float32 values, as the APIs return them.
    return [
        struct.unpack("<f", struct.pack("<f", ((seed * 7919 + i) % 2001 - 1000) / 9973))[0]
        for i in range(dimension)
    ]


def _openai_reply(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    dimension = body.get("dimensions") or 1536
    data = []
    for index, _ in enumerate(body["input"]):
        embedding: Any = _vector(dimension, index)
        if body.get("encoding_format") == "base64":
            embedding = base64.b64encode(struct.pack(f"<{dimension}f", *embedding)).decode()
        data.append({"object": "embedding", "index": index, "embedding": embedding})
    usage = {"prompt_tokens": 1200, "total_tokens": 1200}
    return httpx.Response(
        200, json={"object": "list", "model": MODEL, "data": data, "usage": usage}
    )


@pytest.fixture
def router() -> Iterator[respx.MockRouter]:
    with respx.mock(assert_all_called=False) as mocked:
        mocked.post("https://api.openai.com/v1/embeddings").mock(side_effect=_openai_reply)
        yield mocked


def _session(*, capture: bool) -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="embeddings-event-size",
        agent_type="production",
        quiet=True,
        capture_prompts=capture,
    )
    client = MagicMock(spec=ControlPlaneClient)
    client.post_event.return_value = (None, False)
    session = Session(config=config, client=client, event_queue=MagicMock())
    session.policy = PolicyCache(token_limit=None, block_at_pct=100)
    return session


@pytest.fixture
def openai_session(monkeypatch: pytest.MonkeyPatch) -> Iterator[Any]:
    def _install(*, capture: bool = True) -> Session:
        session = _session(capture=capture)
        monkeypatch.setattr(flightdeck_sensor, "_session", session)
        patch_openai_classes(quiet=True)
        return session

    yield _install
    unpatch_openai_classes()


def _sent_embeddings_event(session: Session) -> tuple[bytes, dict[str, Any]]:
    """The body the transport sends for the call's embeddings event."""
    calls = session.event_queue.enqueue.call_args_list  # type: ignore[attr-defined]
    payloads = [dict(c.args[0]) for c in calls]
    found = [p for p in payloads if p["event_type"] == "embeddings"]
    assert len(found) == 1, [p["event_type"] for p in payloads]
    body = serialize_event(found[0])
    return body, json.loads(body)


def _assert_input_kept_and_vectors_marked(
    body: bytes, event: dict[str, Any], sent_input: Any, vectors: Any
) -> None:
    assert encoded_size(body) <= MAX_EVENT_BODY_BYTES
    assert event["has_content"] is True
    content = event["content"]
    assert content["input"] == sent_input
    assert content["embedding_output"] == truncation_marker(0, len(json.dumps(vectors).encode()))
    assert content["response"] == {}


def test_an_openai_batch_of_30_at_1536_dimensions_keeps_its_input(
    router: respx.MockRouter, openai_session: Any
) -> None:
    session = openai_session()
    reply = openai.OpenAI(api_key="k", max_retries=0).embeddings.create(model=MODEL, input=TEXTS)
    vectors = [list(entry.embedding) for entry in reply.data]
    body, event = _sent_embeddings_event(session)
    _assert_input_kept_and_vectors_marked(body, event, TEXTS, vectors)
    assert event["output_dimensions"] == {"count": 30, "dimension": 1536}
    assert event["tokens_input"] == 1200


def test_openai_base64_vectors_give_way_whole(
    router: respx.MockRouter, openai_session: Any
) -> None:
    texts = [f"short text {i}" for i in range(100)]
    session = openai_session()
    reply = openai.OpenAI(api_key="k", max_retries=0).embeddings.create(
        model=MODEL, input=texts, encoding_format="base64"
    )
    vectors = [entry.embedding for entry in reply.data]
    assert all(isinstance(vector, str) for vector in vectors)
    body, event = _sent_embeddings_event(session)
    _assert_input_kept_and_vectors_marked(body, event, texts, vectors)
    assert event["output_dimensions"] == {"count": 100, "dimension": 1536}


def test_capture_off_sends_no_content(router: respx.MockRouter, openai_session: Any) -> None:
    session = openai_session(capture=False)
    openai.OpenAI(api_key="k", max_retries=0).embeddings.create(model=MODEL, input=TEXTS)
    body, event = _sent_embeddings_event(session)
    assert event["has_content"] is False
    assert event.get("content") is None
    assert b"lorem" not in body and b"flightdeck: kept" not in body
    assert event["output_dimensions"] == {"count": 30, "dimension": 1536}


def test_a_litellm_batch_of_30_at_1536_dimensions_keeps_its_input(
    router: respx.MockRouter, monkeypatch: pytest.MonkeyPatch
) -> None:
    litellm = pytest.importorskip("litellm")
    from flightdeck_sensor.interceptor.litellm import (
        patch_litellm_functions,
        unpatch_litellm_functions,
    )

    session = _session(capture=True)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    patch_litellm_functions(quiet=True)
    try:
        reply = litellm.embedding(
            model=MODEL,
            input=TEXTS,
            client=openai.OpenAI(api_key="k", max_retries=0),
            api_key="k",
        )
    finally:
        unpatch_litellm_functions()
    vectors = [entry["embedding"] for entry in reply.data]
    body, event = _sent_embeddings_event(session)
    _assert_input_kept_and_vectors_marked(body, event, TEXTS, vectors)
    assert event["output_dimensions"] == {"count": 30, "dimension": 1536}


def _gemini_reply(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    assert request.url.path.endswith(":batchEmbedContents"), request.url.path
    embeddings = [{"values": _vector(3072, i)} for i, _ in enumerate(body["requests"])]
    return httpx.Response(200, json={"embeddings": embeddings})


def test_a_google_genai_batch_of_12_at_3072_dimensions_keeps_its_contents(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pytest.importorskip("google.genai")
    from google import genai
    from google.genai import types

    from flightdeck_sensor.interceptor import google_genai as interceptor

    session = _session(capture=True)
    monkeypatch.setattr(flightdeck_sensor, "_session", session)
    requests: list[httpx.Request] = []

    def _answer(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return _gemini_reply(request)

    options = types.HttpOptions(httpx_client=httpx.Client(transport=httpx.MockTransport(_answer)))
    client = genai.Client(api_key="test-key", http_options=options)
    interceptor.patch_google_genai(quiet=True)
    try:
        reply = client.models.embed_content(model=GEMINI_MODEL, contents=TEXTS[:12])
    finally:
        interceptor.unpatch_google_genai()
    assert reply.embeddings is not None
    vectors = [list(e.values or []) for e in reply.embeddings]
    (sent,) = [json.loads(r.content) for r in requests]
    body, event = _sent_embeddings_event(session)
    _assert_input_kept_and_vectors_marked(
        body, event, [r["content"] for r in sent["requests"]], vectors
    )
    assert event["content"]["input"][0] == {"parts": [{"text": TEXTS[0]}], "role": "user"}
    assert event["output_dimensions"] == {"count": 12, "dimension": 3072}
