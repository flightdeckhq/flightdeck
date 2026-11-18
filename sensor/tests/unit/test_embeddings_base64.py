"""An embeddings call made with ``encoding_format="base64"`` reports the
true dimension and stores each vector as the provider returned it.

The OpenAI API (and litellm, which passes the option on) returns each
vector as the base64 string of its float32 values when the call asks for
that format, and the SDK hands the string back as it is. The dimension is
the number of float32 values the string decodes to; the stored vector is
the string, never its characters as a list. google-genai has no such
option: its vectors are always lists of floats.

Driven with the real ``openai`` client (and litellm over it) through
respx; the vectors are float32 values, so the decoded dimension is exact.
"""

from __future__ import annotations

import array
import asyncio
import base64
import binascii
import inspect
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
from flightdeck_sensor.providers._access import vector_dimension
from flightdeck_sensor.transport.body_limit import serialize_event
from flightdeck_sensor.transport.client import ControlPlaneClient

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator

MODEL = "text-embedding-3-small"
TEXTS = ["first text", "second text"]


def _vector(dimension: int, seed: int) -> list[float]:
    # float32 values, as the API returns them.
    return [struct.unpack("<f", struct.pack("<f", (seed + i) / 1000))[0] for i in range(dimension)]


def _encoded(vector: list[float]) -> str:
    return base64.b64encode(struct.pack(f"<{len(vector)}f", *vector)).decode()


def _reply(request: httpx.Request) -> httpx.Response:
    body = json.loads(request.content)
    texts = body["input"] if isinstance(body["input"], list) else [body["input"]]
    dimension = body.get("dimensions") or 1536
    data = []
    for index, _ in enumerate(texts):
        vector = _vector(dimension, index)
        embedding: Any = vector
        if body.get("encoding_format") == "base64":
            embedding = _encoded(vector)
        data.append({"object": "embedding", "index": index, "embedding": embedding})
    usage = {"prompt_tokens": 4, "total_tokens": 4}
    return httpx.Response(
        200, json={"object": "list", "model": MODEL, "data": data, "usage": usage}
    )


@pytest.fixture
def router() -> Iterator[respx.MockRouter]:
    with respx.mock(assert_all_called=False) as mocked:
        mocked.post("https://api.openai.com/v1/embeddings", name="embeddings").mock(
            side_effect=_reply
        )
        yield mocked


def _session(*, capture: bool) -> Session:
    config = SensorConfig(
        server="http://localhost:9999",
        token="tok",
        agent_flavor="embeddings-base64",
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
def sensored(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[..., Session]]:
    def _install(*, capture: bool = True) -> Session:
        session = _session(capture=capture)
        monkeypatch.setattr(flightdeck_sensor, "_session", session)
        patch_openai_classes(quiet=True)
        return session

    yield _install
    unpatch_openai_classes()


def _embeddings_event(session: Session) -> dict[str, Any]:
    calls = session.event_queue.enqueue.call_args_list  # type: ignore[attr-defined]
    events = [json.loads(serialize_event(dict(c.args[0]))) for c in calls]
    found = [e for e in events if e["event_type"] == "embeddings"]
    assert len(found) == 1, [e["event_type"] for e in events]
    return found[0]


def _run(make: Callable[[], Any]) -> Any:
    async def _resolved() -> Any:
        value = make()
        return await value if inspect.isawaitable(value) else value

    return asyncio.run(_resolved())


def _openai(is_async: bool, **kwargs: Any) -> Any:
    cls: Any = openai.AsyncOpenAI if is_async else openai.OpenAI
    client = cls(api_key="k", max_retries=0)
    return _run(lambda: client.embeddings.create(model=MODEL, input=TEXTS, **kwargs))


@pytest.mark.parametrize("dimensions", [None, 64], ids=["default", "dimensions=64"])
@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_a_base64_call_reports_the_decoded_dimension_and_stores_the_strings(
    is_async: bool,
    dimensions: int | None,
    router: respx.MockRouter,
    sensored: Callable[..., Session],
) -> None:
    session = sensored()
    extra = {} if dimensions is None else {"dimensions": dimensions}
    reply = _openai(is_async, encoding_format="base64", **extra)
    returned = [entry.embedding for entry in reply.data]
    assert all(isinstance(vector, str) for vector in returned)
    event = _embeddings_event(session)
    assert event["output_dimensions"] == {"count": 2, "dimension": dimensions or 1536}
    assert event["content"]["embedding_output"] == returned


@pytest.mark.parametrize("is_async", [False, True], ids=["sync", "async"])
def test_a_float_call_is_reported_as_before(
    is_async: bool, router: respx.MockRouter, sensored: Callable[..., Session]
) -> None:
    session = sensored()
    reply = _openai(is_async)
    event = _embeddings_event(session)
    assert event["output_dimensions"] == {"count": 2, "dimension": 1536}
    assert event["content"]["embedding_output"] == [list(e.embedding) for e in reply.data]


def test_a_base64_call_with_capture_off_still_reports_the_dimension(
    router: respx.MockRouter, sensored: Callable[..., Session]
) -> None:
    session = sensored(capture=False)
    _openai(False, encoding_format="base64")
    event = _embeddings_event(session)
    assert event["output_dimensions"] == {"count": 2, "dimension": 1536}
    assert event["has_content"] is False
    assert event.get("content") is None


def test_a_reply_whose_base64_does_not_decode_reports_no_dimension(
    router: respx.MockRouter, sensored: Callable[..., Session]
) -> None:
    """A string that is not base64 of whole float32 values has no dimension
    to report: the event goes without ``output_dimensions`` (which needs a
    positive one) and still stores what the provider returned."""
    garbled = "this is not base64!"
    router.routes["embeddings"].mock(
        return_value=httpx.Response(
            200,
            json={
                "object": "list",
                "model": MODEL,
                "data": [{"object": "embedding", "index": 0, "embedding": garbled}],
                "usage": {"prompt_tokens": 4, "total_tokens": 4},
            },
        )
    )
    session = sensored()
    _openai(False, encoding_format="base64")
    event = _embeddings_event(session)
    assert "output_dimensions" not in event
    assert event["content"]["embedding_output"] == [garbled]
    assert event["tokens_input"] == 4


def test_a_litellm_base64_call_reports_the_decoded_dimension_and_stores_the_strings(
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
            encoding_format="base64",
            client=openai.OpenAI(api_key="k", max_retries=0),
            api_key="k",
        )
    finally:
        unpatch_litellm_functions()
    returned = [entry["embedding"] for entry in reply.data]
    assert all(isinstance(vector, str) for vector in returned)
    event = _embeddings_event(session)
    assert event["output_dimensions"] == {"count": 2, "dimension": 1536}
    assert event["content"]["embedding_output"] == returned


@pytest.mark.parametrize(
    ("embedding", "dimension"),
    [
        ([0.5, 0.25, 0.125], 3),
        (_encoded([0.5, 0.25, 0.125]), 3),
        (base64.b64encode(b"\x00" * 6).decode(), None),
        ("not base64 at all", None),
        ("", None),
        ([], None),
        (None, None),
    ],
    ids=["floats", "base64", "partial float32", "not base64", "empty string", "empty", "none"],
)
def test_vector_dimension(embedding: Any, dimension: int | None) -> None:
    assert vector_dimension(embedding) == dimension


def _sdk_decoded(embedding: str) -> list[float] | None:
    """What the OpenAI SDK makes of a base64 embedding without numpy
    (``array.array("f", base64.b64decode(...))``, the same values
    ``numpy.frombuffer(..., dtype="float32")`` gives), or ``None`` where
    that raises."""
    try:
        return array.array("f", base64.b64decode(embedding)).tolist()
    except (binascii.Error, ValueError):
        return None


_ENCODED = _encoded([0.5, 0.25, 0.125, 1.0])


@pytest.mark.parametrize(
    "embedding",
    [
        _ENCODED,
        _ENCODED[:8] + "\n" + _ENCODED[8:],
        " " + _ENCODED + " ",
        _ENCODED + "!*",
        _ENCODED.rstrip("="),
        _ENCODED[:-2],
        base64.b64encode(b"\x00" * 6).decode(),
        "QUJD",
        "",
    ],
    ids=[
        "plain",
        "a line break inside",
        "spaces around",
        "characters outside the alphabet",
        "no padding needed",
        "padding cut",
        "partial float32",
        "three bytes",
        "empty",
    ],
)
def test_the_dimension_is_what_the_sdks_own_decoding_gives(embedding: str) -> None:
    """Decoded as the SDK decodes it: characters outside the base64
    alphabet are skipped, bad padding raises; a string the SDK cannot
    decode into whole float32 values has no dimension, and neither has one
    that decodes to no values."""
    decoded = _sdk_decoded(embedding)
    assert vector_dimension(embedding) == (len(decoded) if decoded else None)


def test_an_empty_vector_is_stored_as_returned(
    router: respx.MockRouter, sensored: Callable[..., Session]
) -> None:
    """An empty string the provider returned for a vector is stored as
    that string, not dropped; it has no dimension, so the event carries no
    ``output_dimensions``."""
    router.routes["embeddings"].mock(
        return_value=httpx.Response(
            200,
            json={
                "object": "list",
                "model": MODEL,
                "data": [{"object": "embedding", "index": 0, "embedding": ""}],
                "usage": {"prompt_tokens": 4, "total_tokens": 4},
            },
        )
    )
    session = sensored()
    _openai(False, encoding_format="base64")
    event = _embeddings_event(session)
    assert event["content"]["embedding_output"] == [""]
    assert "output_dimensions" not in event


def test_google_genai_has_no_encoding_option() -> None:
    """google-genai returns its vectors as floats only: the embed config
    has no encoding option for this rule to cover."""
    types = pytest.importorskip("google.genai.types")
    fields = set(types.EmbedContentConfig.model_fields)
    assert not {name for name in fields if "encoding" in name or "format" in name}
