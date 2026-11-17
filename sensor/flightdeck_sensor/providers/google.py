"""Google provider: Gemini through the google-genai SDK, on the Gemini API
or Vertex AI.

Reads the SDK's ``GenerateContentResponse`` (a call, or one chunk of a
stream) and ``EmbedContentResponse``, and the arguments of the request
methods the interceptor patches (``model``, ``contents``, ``config``).
Every read also takes the plain dict a streamed response is assembled
into (see :class:`_StreamAccumulator`), through
:func:`flightdeck_sensor.providers._access.field`.

Tokens. Gemini reports ``prompt_token_count`` (which includes the cached
content), ``candidates_token_count``, ``thoughts_token_count`` (the
thinking the model did, billed as output but not counted in the
candidates), ``tool_use_prompt_token_count`` (the results of tools the
API itself ran, read back as input) and ``cached_content_token_count``.
The sensor's ``TokenUsage`` holds reasoning as a subset of the output, as
every other provider reports it, so the output is the candidates plus the
thoughts, the reasoning the thoughts, and the input the prompt plus the
tool-use prompt, with the cached tokens as its cache read.
"""

from __future__ import annotations

import base64
import contextlib
import enum
import logging
from datetime import UTC
from typing import Any

from flightdeck_sensor.core.types import CallDetails, TokenUsage
from flightdeck_sensor.providers._access import field as _field
from flightdeck_sensor.providers.protocol import (
    PromptContent,
    StreamAccumulator,
    ToolInvocation,
)

_log = logging.getLogger("flightdeck_sensor.providers.google")

# The provider's wire name and the vendor stamped on its calls: every
# endpoint google-genai talks to (the Gemini API, Vertex AI, a proxy in
# front of either) serves Google's models.
GOOGLE = "google"

_CHARS_PER_TOKEN_ESTIMATE = 4
# Token allowance per inline binary payload (a ``Blob`` part's ``data``, a
# PIL image) in a request. Gemini prices an image at 258 tokens per
# 768x768 tile (about 1,000 for a 1536x1536 image) and audio, video and
# PDF pages by duration and page, not by their bytes, so the payload is
# dropped from the character count and this allowance is added per
# payload instead; counted as text, a 2 MB image would estimate as
# hundreds of thousands of tokens and could trip a policy limit before
# the call.
_INLINE_DATA_TOKEN_ALLOWANCE = 1_000
# The part field that holds an inline payload, as the SDK names it and as
# the REST API does (a dict given by the caller may use either).
_INLINE_DATA_KEYS = frozenset({"inline_data", "inlineData"})
_INLINE_DATA_FIELD = "data"
# The package an image object the SDK reads (``PIL.Image.Image``) comes from.
_PIL_PACKAGE = "PIL."
# How deep the estimate's walk for inline payloads and the request's JSON
# form go into a value; a request nests a few levels (contents, a
# content, its parts, a part's blob, a function call's arguments), and
# the limit stops a walk on a value that holds itself.
_MAX_DEPTH = 32

# Fields the SDK sets on a response object itself rather than reading
# them from the provider's answer: the HTTP headers, the history of an
# automatic-function-calling run, and the caller's parsed schema object.
# The stored response holds what the provider returned.
_SDK_RESPONSE_FIELDS = frozenset(
    {"sdk_http_response", "automatic_function_calling_history", "parsed"}
)

# The response header the Gemini API names the tier that served the call
# in (``standard``, ``flex``, ``priority``).
_SERVICE_TIER_HEADER = "x-gemini-service-tier"

# A part's fields when it is streamed text and nothing else: adjacent such
# parts of one candidate are joined when a stream is assembled.
_PLAIN_TEXT_FIELDS = frozenset({"text", "thought"})


def _count(value: Any) -> int | None:
    """A token count as reported, or ``None`` when the field is missing
    or not an integer."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    # Vertex AI's embedding statistics report counts as floats.
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def _text(value: Any) -> str | None:
    """An enum member's value (the SDK's ``FinishReason``,
    ``BlockedReason``) or a plain string; ``None`` for anything else."""
    if isinstance(value, enum.Enum):
        value = value.value
    return value if isinstance(value, str) and value else None


def _as_json(value: Any, depth: int = 0) -> Any:
    """``value`` as google-genai writes it into a request: an SDK model as
    its JSON dump of the fields that are not None, by field name; bytes
    as URL-safe base64 (the SDK's ``encode_unserializable_types``); the
    lists, tuples and dicts it is made of, item by item. Anything else is
    returned as it is, so an object JSON cannot write (a PIL image, which
    the SDK encodes itself) leaves the event without its content rather
    than stored as a string."""
    if depth >= _MAX_DEPTH:
        return value
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, bytes):
        return base64.urlsafe_b64encode(value).decode("ascii")
    if isinstance(value, dict):
        return {key: _as_json(item, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_as_json(item, depth + 1) for item in value]
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        with contextlib.suppress(Exception):
            return dump(mode="json", exclude_none=True, warnings=False)
    return value


def _without_inline_data(value: Any, depth: int = 0) -> tuple[Any, int]:
    """``value`` with every inline payload (a part's ``inline_data.data``,
    a PIL image) taken out, and how many were taken out. Containers are
    copied; everything else is returned as it is."""
    if depth >= _MAX_DEPTH:
        return value, 0
    if type(value).__module__.startswith(_PIL_PACKAGE):
        return "", 1
    if isinstance(value, dict):
        out: dict[Any, Any] = {}
        removed = 0
        for key, item in value.items():
            if key in _INLINE_DATA_KEYS:
                blob = _as_json(item)
                if isinstance(blob, dict) and blob.get(_INLINE_DATA_FIELD):
                    out[key] = {k: v for k, v in blob.items() if k != _INLINE_DATA_FIELD}
                    removed += 1
                    continue
            out[key], n = _without_inline_data(item, depth + 1)
            removed += n
        return out, removed
    if isinstance(value, (list, tuple)):
        items: list[Any] = []
        removed = 0
        for item in value:
            cleaned, n = _without_inline_data(item, depth + 1)
            items.append(cleaned)
            removed += n
        return items, removed
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        # An SDK object the arguments carry as it is (the request's
        # config), read the way it is sent.
        return _without_inline_data(_as_json(value), depth + 1)
    return value, 0


def _system_instruction(value: Any) -> Any:
    """The config's ``system_instruction`` as the content's ``system``,
    which is text or a list (event_content keeps text in ``system_prompt``
    and a list in ``system_blocks``): text as it is, a ``Content`` as its
    parts (the instruction itself; a Content's role says nothing about
    it), a ``Part`` as a list of the one part, a list item by item."""
    if value is None or isinstance(value, str):
        return value
    dumped = _as_json(value)
    if isinstance(dumped, dict):
        parts = dumped.get("parts")
        return parts if isinstance(parts, list) else [dumped]
    return dumped


def _dump_response(response: Any) -> dict[str, Any]:
    """A response object (or an assembled stream's dict) as the provider
    returned it: the JSON dump without the fields the SDK adds itself
    (see :data:`_SDK_RESPONSE_FIELDS`)."""
    if isinstance(response, dict):
        return {k: v for k, v in response.items() if k not in _SDK_RESPONSE_FIELDS}
    dump = getattr(response, "model_dump", None)
    if callable(dump):
        try:
            dumped = dump(
                mode="json", exclude_none=True, exclude=set(_SDK_RESPONSE_FIELDS), warnings=False
            )
        except Exception:
            _log.debug("google response dump failed", exc_info=True)
            return {}
        return dumped if isinstance(dumped, dict) else {}
    return {}


def _headers(response: Any) -> Any:
    return _field(_field(response, "sdk_http_response"), "headers")


def _usage(usage: Any) -> TokenUsage | None:
    """The token counts of a ``usage_metadata`` object (or dict), or
    ``None`` when it reports none (see the module docstring)."""
    if usage is None:
        return None
    prompt = _count(_field(usage, "prompt_token_count")) or 0
    tool_use = _count(_field(usage, "tool_use_prompt_token_count")) or 0
    candidates = _count(_field(usage, "candidates_token_count")) or 0
    thoughts = _count(_field(usage, "thoughts_token_count"))
    cached = _count(_field(usage, "cached_content_token_count")) or 0
    input_tokens = prompt + tool_use
    output_tokens = candidates + (thoughts or 0)
    if input_tokens == 0 and output_tokens == 0:
        return None
    return TokenUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        # The cached content is part of the prompt count; a count that is
        # not (a malformed report) is left out rather than failing the
        # event's subset check.
        cache_read_tokens=cached if cached <= input_tokens else 0,
        reasoning_tokens=thoughts,
    )


def _embedding_usage(response: Any) -> TokenUsage | None:
    """Input tokens of an embeddings response: the per-embedding
    ``statistics.token_count`` Vertex AI reports, summed; ``None`` when no
    embedding carries one (the Gemini API reports none through the SDK)."""
    embeddings = _field(response, "embeddings")
    if not isinstance(embeddings, list):
        return None
    total = 0
    seen = False
    for embedding in embeddings:
        count = _count(_field(_field(embedding, "statistics"), "token_count"))
        if count is not None:
            total += count
            seen = True
    return TokenUsage(input_tokens=total, output_tokens=0) if seen and total > 0 else None


def _stop_reason(response: Any) -> str | None:
    """The first candidate's ``finish_reason``; with no candidate, the
    ``prompt_feedback.block_reason`` of a prompt the filters blocked."""
    candidates = _field(response, "candidates")
    if isinstance(candidates, list) and candidates:
        reason = _text(_field(candidates[0], "finish_reason"))
        if reason is not None:
            return reason
    return _text(_field(_field(response, "prompt_feedback"), "block_reason"))


def _header(headers: Any, name: str) -> Any:
    """A response header by its lower-case name. The SDK keeps the headers
    as a plain dict, lower-cased by the sync client and as sent by the
    async one (``X-Gemini-Service-Tier``)."""
    items = getattr(headers, "items", None)
    if not callable(items):
        return None
    with contextlib.suppress(Exception):
        for key, value in items():
            if isinstance(key, str) and key.lower() == name:
                return value
    return None


def _details(response: Any) -> CallDetails | None:
    model = _field(response, "model_version")
    tier = _header(_headers(response), _SERVICE_TIER_HEADER)
    details = CallDetails(
        model_served=model if isinstance(model, str) and model else None,
        service_tier=tier if isinstance(tier, str) and tier else None,
    )
    return None if details == CallDetails() else details


def _append_part(parts: list[Any], part: Any) -> None:
    """Add one streamed part to a candidate's assembled parts: text that
    is nothing but text (or thought text) joins the text before it of the
    same kind, every other part is kept whole (a function call, inline
    data, a part carrying a thought signature)."""
    if (
        parts
        and isinstance(part, dict)
        and isinstance(parts[-1], dict)
        and set(part) <= _PLAIN_TEXT_FIELDS
        and set(parts[-1]) <= _PLAIN_TEXT_FIELDS
        and isinstance(part.get("text"), str)
        and isinstance(parts[-1].get("text"), str)
        and bool(part.get("thought")) == bool(parts[-1].get("thought"))
    ):
        parts[-1] = {**parts[-1], "text": parts[-1]["text"] + part["text"]}
        return
    parts.append(part)


class _StreamAccumulator:
    """Assembles a ``generate_content_stream`` response from its chunks,
    which the SDK does not do itself: each chunk is a
    ``GenerateContentResponse`` with the parts generated since the last
    one and the usage so far. The assembled message is the response a
    non-streamed call returns, as a dict: each candidate's parts in order
    (adjacent plain text joined), its last finish reason and safety
    ratings, and the last chunk's usage, model version and response id.
    Chunks are kept as they arrive and read only when the message is
    asked for, once, when the stream settles."""

    def __init__(self) -> None:
        self._chunks: list[Any] = []

    def add(self, chunk: Any) -> None:
        self._chunks.append(chunk)

    def message(self) -> Any | None:
        if not self._chunks:
            return None
        out: dict[str, Any] = {}
        candidates: dict[Any, dict[str, Any]] = {}
        for chunk in self._chunks:
            dumped = _dump_response(chunk)
            for key, value in dumped.items():
                if key != "candidates":
                    out[key] = value
            for position, candidate in enumerate(dumped.get("candidates") or ()):
                if not isinstance(candidate, dict):
                    continue
                merged = candidates.setdefault(candidate.get("index", position), {})
                for key, value in candidate.items():
                    if key != "content" or not isinstance(value, dict):
                        merged[key] = value
                        continue
                    content = merged.setdefault("content", {})
                    if "role" in value:
                        content["role"] = value["role"]
                    parts = content.setdefault("parts", [])
                    for part in value.get("parts") or ():
                        _append_part(parts, part)
        if candidates:
            out["candidates"] = list(candidates.values())
        return out


class GoogleProvider:
    """Provider adapter for the google-genai SDK.

    All methods are safe to call on the hot path. None of them raise
    exceptions -- failures return zero/empty defaults.
    """

    name = GOOGLE

    def __init__(
        self,
        capture_prompts: bool = False,
        platform: str | None = None,
        *,
        local: bool = False,
        inference_scope: str | None = None,
        api_client: Any = None,
    ) -> None:
        self._capture_prompts = capture_prompts
        # gemini-api, vertex, or the host of whatever the client was
        # pointed at; reported under provider_metadata.platform.
        self._platform = platform
        self._local = local
        self._inference_scope = inference_scope
        # The SDK's API client of the call, which the SDK's own tool
        # transform takes (it builds a function declaration from a Python
        # function differently for Vertex AI).
        self._api_client = api_client

    @property
    def platform(self) -> str | None:
        return self._platform

    @property
    def vendor(self) -> str | None:
        return GOOGLE

    @property
    def local(self) -> bool:
        return self._local

    @property
    def inference_scope(self) -> str | None:
        return self._inference_scope

    # -- request -------------------------------------------------------

    def get_model(self, request_kwargs: dict[str, Any]) -> str:
        """The ``model`` argument as the caller gave it."""
        try:
            model = request_kwargs["model"]
        except (KeyError, TypeError):
            return ""
        return model if isinstance(model, str) else ""

    def estimate_tokens(self, request_kwargs: dict[str, Any]) -> tuple[int, str]:
        """Estimate input tokens from the characters of the request's
        ``contents`` (or an embeddings call's single ``content``), the
        config's ``system_instruction`` and its ``tools``, four to a
        token, with each inline payload priced at a fixed allowance
        instead of its bytes (see :data:`_INLINE_DATA_TOKEN_ALLOWANCE`).
        Gemini's tokenizer is not local and the SDK's ``count_tokens`` is
        a network call, so the source is always ``heuristic``."""
        try:
            config = request_kwargs.get("config")
            parts = (
                request_kwargs.get("contents"),
                request_kwargs.get("content"),
                _field(config, "system_instruction"),
                _field(config, "tools"),
            )
            cleaned, payloads = _without_inline_data(parts)
            text = "".join(str(part) for part in cleaned if part is not None)
            return (
                len(text) // _CHARS_PER_TOKEN_ESTIMATE + payloads * _INLINE_DATA_TOKEN_ALLOWANCE,
                "heuristic",
            )
        except Exception:
            _log.debug("google estimate failed", exc_info=True)
            return 0, "none"

    # -- response ------------------------------------------------------

    def extract_usage(self, response: Any) -> TokenUsage:
        """Tokens of a ``GenerateContentResponse`` (see the module
        docstring) or of an ``EmbedContentResponse`` (see
        :func:`_embedding_usage`)."""
        try:
            usage = _usage(_field(response, "usage_metadata"))
            if usage is None:
                usage = _embedding_usage(response)
            return usage or TokenUsage()
        except Exception:
            return TokenUsage()

    def usage_from_stream_chunk(self, chunk: Any) -> TokenUsage | None:
        """Every streamed chunk carries the usage so far (cumulative), the
        last one the whole call's."""
        try:
            return _usage(_field(chunk, "usage_metadata"))
        except Exception:
            return None

    def usage_from_finished_stream(self, stream: Any) -> TokenUsage | None:
        """The SDK's stream is a plain generator that holds no usage."""
        return None

    def stream_completed(self, stream: Any) -> bool | None:
        return None

    def final_message(self, stream: Any) -> Any | None:
        return None

    def stream_accumulator(
        self, stream: Any, request_kwargs: dict[str, Any]
    ) -> StreamAccumulator | None:
        """A :class:`_StreamAccumulator` when something reads the
        assembled response: content capture, or a request that offers
        the model tools and so may stream function calls."""
        try:
            offers_tools = bool(_field(request_kwargs.get("config"), "tools"))
        except Exception:
            offers_tools = False
        if not (self._capture_prompts or offers_tools):
            return None
        return _StreamAccumulator()

    def text_from_stream_chunk(self, chunk: Any) -> str | None:
        """The SDK's streams have no ``text_stream``."""
        return None

    def chunk_completes_stream(self, chunk: Any) -> bool:
        """The chunk that carries the finish reason (or a blocked prompt's
        block reason) is the last of the response."""
        try:
            return _stop_reason(chunk) is not None
        except Exception:
            return False

    def response_stop_reason(self, response: Any) -> str | None:
        """The first candidate's ``finish_reason`` (``STOP``,
        ``MAX_TOKENS``, ``SAFETY``, ...), or a blocked prompt's
        ``prompt_feedback.block_reason``."""
        try:
            return _stop_reason(response)
        except Exception:
            return None

    def stop_reason_from_stream_chunk(self, chunk: Any) -> str | None:
        try:
            return _stop_reason(chunk)
        except Exception:
            return None

    def call_details(self, response: Any) -> CallDetails | None:
        """The served model (``model_version``) and the service tier the
        ``x-gemini-service-tier`` response header names."""
        try:
            return _details(response)
        except Exception:
            return None

    def call_details_from_stream_chunk(self, chunk: Any) -> CallDetails | None:
        try:
            return _details(chunk)
        except Exception:
            return None

    def extract_response_metadata(self, response: Any) -> dict[str, Any] | None:
        """The platform the call went to; Gemini responses carry no
        rate-limit or request-id headers."""
        return {"platform": self._platform} if self._platform else None

    def extract_output_dimensions(self, response: Any) -> dict[str, int] | None:
        """``{count, dimension}`` of an ``EmbedContentResponse``."""
        try:
            embeddings = _field(response, "embeddings")
            if not isinstance(embeddings, list) or not embeddings:
                return None
            values = _field(embeddings[0], "values")
            if not values:
                return None
            return {"count": len(embeddings), "dimension": len(values)}
        except Exception:
            return None

    def extract_tool_invocations(self, response: Any) -> list[ToolInvocation]:
        """One :class:`ToolInvocation` per ``function_call`` part of the
        first candidate, the call the model asked for (the SDK runs it
        itself under automatic function calling)."""
        try:
            candidates = _field(response, "candidates")
            if not isinstance(candidates, list) or not candidates:
                return []
            parts = _field(_field(candidates[0], "content"), "parts") or ()
            invocations: list[ToolInvocation] = []
            for part in parts:
                call = _field(part, "function_call")
                name = _field(call, "name")
                if not isinstance(name, str) or not name:
                    continue
                args = _as_json(_field(call, "args"))
                call_id = _field(call, "id")
                invocations.append(
                    ToolInvocation(
                        name=name,
                        tool_input=args if isinstance(args, dict) else {},
                        tool_id=call_id if isinstance(call_id, str) and call_id else None,
                    )
                )
            return invocations
        except Exception:
            _log.debug("extract_tool_invocations failed", exc_info=True)
            return []

    # -- content -------------------------------------------------------

    def _tools_as_sent(self, tools: Any) -> Any:
        """The config's ``tools`` as stored: each one as the caller gave
        it (an SDK ``Tool`` as its dump, a dict as written), except a
        Python function, which the SDK sends as the function declaration
        its own tool transform builds from it (the tool the model is
        offered under automatic function calling). A tool the transform
        cannot read is left as it is."""
        if not isinstance(tools, (list, tuple)):
            return _as_json(tools)
        out: list[Any] = []
        for tool in tools:
            if callable(tool) and not hasattr(tool, "model_dump"):
                try:
                    from google.genai import _transformers

                    tool = _transformers.t_tool(self._api_client, tool)
                except Exception:
                    _log.debug("google tool transform failed", exc_info=True)
            out.append(_as_json(tool))
        return out

    def extract_content(
        self,
        request_kwargs: dict[str, Any],
        response: Any,
        event_type: Any = None,
    ) -> PromptContent | None:
        """The request and response in Gemini's own terms. ``input`` holds
        the request's ``contents`` as the caller gave them to the SDK (a
        string, a ``Content`` or ``Part``, or a list of them, SDK objects
        as their dump; an embeddings call on Vertex AI's single-content
        API, its ``content``), ``system`` the config's
        ``system_instruction`` (see :func:`_system_instruction`), ``tools`` its tools (see
        :meth:`_tools_as_sent`), ``response`` the ``candidates``, usage
        and model version as the provider returned them; ``messages``
        stays empty, as Gemini has no messages parameter. Returns ``None``
        when capture_prompts is off. Never raises."""
        if not self._capture_prompts:
            return None
        try:
            from datetime import datetime

            from flightdeck_sensor.core.types import EventType

            now = datetime.now(UTC).isoformat()
            model = self.get_model(request_kwargs)
            contents = request_kwargs.get("contents")
            if contents is None:
                contents = request_kwargs.get("content")
            config = request_kwargs.get("config")
            if event_type == EventType.EMBEDDINGS:
                vectors: list[list[float]] | None = None
                embeddings = _field(response, "embeddings")
                if isinstance(embeddings, list):
                    vectors = [
                        list(values)
                        for values in (_field(e, "values") for e in embeddings)
                        if values is not None
                    ]
                return PromptContent(
                    system=None,
                    messages=[],
                    tools=None,
                    response={},
                    provider=GOOGLE,
                    model=model,
                    session_id="",
                    event_id="",
                    captured_at=now,
                    input=_as_json(contents),
                    embedding_output=vectors,
                )
            tools = _field(config, "tools")
            return PromptContent(
                system=_system_instruction(_field(config, "system_instruction")),
                messages=[],
                tools=self._tools_as_sent(tools) if tools else None,
                response=_dump_response(response),
                provider=GOOGLE,
                model=model,
                session_id="",
                event_id="",
                captured_at=now,
                input=_as_json(contents),
            )
        except Exception:
            _log.debug("extract_content failed", exc_info=True)
            return None
