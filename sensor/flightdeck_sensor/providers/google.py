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

Content. What is stored is what the provider received and returned, read
from the request the SDK built (see :class:`SentRequest`), never rebuilt
from the caller's arguments: the SDK turns them into the request its own
way (a string into a ``user`` turn, Python functions into declarations,
bytes into base64), with a spelling that depends on its release and on
the platform (``inlineData`` beside ``mime_type``, ``functionDeclarations``
beside ``parameters_json_schema``).
"""

from __future__ import annotations

import base64
import contextlib
import enum
import json
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


# The position of the request in the arguments the SDK's request methods
# hand their API client (``request(http_method, path, request_dict,
# http_options)``, and the streamed and async forms), and its name when
# passed by keyword.
_REQUEST_DICT_POSITION = 2
_REQUEST_DICT_NAME = "request_dict"
# The SDK keeps the request's URL parts beside its body under keys that
# start with this (``_url``, ``_query``); its API client drops them before
# it sends the body.
_SDK_KEY_PREFIX = "_"
# The request body's fields content capture stores, as the request names
# them: the conversation, the system instruction and the tools of a
# ``generateContent`` request; the contents of an embeddings request,
# one per request of a batch (``batchEmbedContents``), per instance
# (Vertex AI's ``predict``) or the request's own (``embedContent``).
_CONTENTS = "contents"
_SYSTEM_INSTRUCTION = "systemInstruction"
_TOOLS = "tools"
_PARTS = "parts"
_EMBED_CONTENT = "content"
_EMBED_BATCH_KEYS = ("requests", "instances")


class SentRequest:
    """What one call of a patched request method handed the SDK's API
    client, recorded by the interceptor (see its ``_RecordingClient``)
    when content capture is on: the request as the SDK built it, with the
    URL keys the client drops before sending left out, so the body the
    provider received; and, for a call that is not streamed, the response
    body the client returned, as text. Both stay None when the SDK sent
    nothing through the methods the interceptor records."""

    __slots__ = ("body", "request")

    def __init__(self) -> None:
        self.request: dict[str, Any] | None = None
        self.body: str | None = None

    def keep(self, args: tuple[Any, ...], kwargs: dict[str, Any]) -> None:
        """Record the request of one API client call. The SDK builds a new
        dict for each request (its converters' output), so a copy of its
        top level is enough: what the client is handed is never the
        caller's own object."""
        if len(args) > _REQUEST_DICT_POSITION:
            request = args[_REQUEST_DICT_POSITION]
        else:
            request = kwargs.get(_REQUEST_DICT_NAME)
        if isinstance(request, dict):
            self.request = {
                key: value
                for key, value in request.items()
                if not (isinstance(key, str) and key.startswith(_SDK_KEY_PREFIX))
            }


# The kinds of content that could not be read, each warned of once per
# process, by kind and never by value (the value is captured content).
_WARNED: set[str] = set()


def _warn_once(kind: str) -> None:
    if kind in _WARNED:
        return
    _WARNED.add(kind)
    _log.warning(
        "google-genai %s could not be read as the provider received it; "
        "the event is sent without its content",
        kind,
    )


def _system_parts(value: Any) -> Any:
    """The request's ``systemInstruction`` as the content's ``system``,
    which event_content keeps as text or as a list: the instruction's
    ``parts``, as sent. The Content around them, and with it its
    ``role`` (``user`` when the SDK builds it, the caller's own when the
    caller passes a Content), is not stored. None when the request has
    no system instruction."""
    if isinstance(value, dict):
        parts = value.get(_PARTS)
        return parts if isinstance(parts, list) else None
    return value if isinstance(value, (str, list)) else None


def _embedding_inputs(request: dict[str, Any]) -> Any:
    """An embeddings request's contents as sent: each batched request's or
    instance's ``content``, in order, else the request's own."""
    for key in _EMBED_BATCH_KEYS:
        entries = request.get(key)
        if isinstance(entries, list):
            return [e.get(_EMBED_CONTENT) if isinstance(e, dict) else e for e in entries]
    return request.get(_EMBED_CONTENT)


def _dump_response(response: Any, *, by_alias: bool = False) -> dict[str, Any]:
    """A response object (or an assembled stream's dict) as the provider
    returned it: the JSON dump without the fields the SDK adds itself
    (see :data:`_SDK_RESPONSE_FIELDS`), by field name for the sensor's own
    reads, or by alias, the REST API's names, for the stored content."""
    if isinstance(response, dict):
        return {k: v for k, v in response.items() if k not in _SDK_RESPONSE_FIELDS}
    dump = getattr(response, "model_dump", None)
    if callable(dump):
        try:
            dumped = dump(
                mode="json",
                by_alias=by_alias,
                exclude_none=True,
                exclude=set(_SDK_RESPONSE_FIELDS),
                warnings=False,
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


def _assemble(chunks: list[Any], *, by_alias: bool) -> dict[str, Any]:
    """The response a non-streamed call returns, as a dict, assembled from
    a stream's chunks (see :class:`_StreamAccumulator`). The keys the
    assembly reads (``candidates``, ``index``, ``content``, ``role``,
    ``parts``, ``text``, ``thought``) are spelled the same by field name
    and by alias."""
    out: dict[str, Any] = {}
    candidates: dict[Any, dict[str, Any]] = {}
    for chunk in chunks:
        dumped = _dump_response(chunk, by_alias=by_alias)
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


class _Assembled(dict):  # type: ignore[type-arg]
    """An assembled stream's response by field name, which the sensor's
    own reads take, carrying the same response by alias for the stored
    content when content capture asked for it."""

    by_alias: dict[str, Any] | None = None


class _StreamAccumulator:
    """Assembles a ``generate_content_stream`` response from its chunks,
    which the SDK does not do itself: each chunk is a
    ``GenerateContentResponse`` with the parts generated since the last
    one and the usage so far. The assembled message is the response a
    non-streamed call returns, as a dict: each candidate's parts in order
    (adjacent plain text joined), its last finish reason and safety
    ratings, and the last chunk's usage, model version and response id.
    Chunks are kept as they arrive and read only when the message is
    asked for, once, when the stream settles. With ``by_alias`` (content
    capture on) the message also carries the response by alias, the
    REST API's names, for the stored content."""

    def __init__(self, *, by_alias: bool = False) -> None:
        self._chunks: list[Any] = []
        self._by_alias = by_alias

    def add(self, chunk: Any) -> None:
        self._chunks.append(chunk)

    def message(self) -> Any | None:
        if not self._chunks:
            return None
        message = _Assembled(_assemble(self._chunks, by_alias=False))
        if self._by_alias:
            message.by_alias = _assemble(self._chunks, by_alias=True)
        return message


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
        sent: SentRequest | None = None,
    ) -> None:
        self._capture_prompts = capture_prompts
        # gemini-api, vertex, or the host of whatever the client was
        # pointed at; reported under provider_metadata.platform.
        self._platform = platform
        self._local = local
        self._inference_scope = inference_scope
        # What this call's request method handed the SDK's API client,
        # recorded by the interceptor with content capture on: the source
        # of the stored content.
        self._sent = sent

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
        return _StreamAccumulator(by_alias=self._capture_prompts)

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

    def _stored_response(self, response: Any) -> dict[str, Any]:
        """The response as the provider returned it: the body the API
        client returned, for a call that is not streamed; for a stream,
        its chunks assembled (see :class:`_StreamAccumulator`), each as
        the SDK's dump by alias with unset fields left out, since a
        stream has no one body; else the response object's dump by
        alias."""
        body = self._sent.body if self._sent is not None else None
        if isinstance(body, str) and body:
            with contextlib.suppress(ValueError):
                parsed = json.loads(body)
                if isinstance(parsed, dict):
                    return parsed
        if isinstance(response, _Assembled) and response.by_alias is not None:
            return response.by_alias
        return _dump_response(response, by_alias=True)

    def extract_content(
        self,
        request_kwargs: dict[str, Any],
        response: Any,
        event_type: Any = None,
    ) -> PromptContent | None:
        """The request and response as the provider received and returned
        them, read from what the call's request method handed the SDK's
        API client (see :class:`SentRequest`), in the request body's own
        names and spelling: ``input`` the body's ``contents`` (an
        embeddings call's contents, see :func:`_embedding_inputs`),
        ``system`` its ``systemInstruction``'s parts (see
        :func:`_system_parts`), ``tools`` its ``tools``, ``response`` the
        response (see :meth:`_stored_response`); ``messages`` stays
        empty, as Gemini has no messages parameter. A call whose request
        was not recorded is stored without content, with a warning once,
        rather than in another shape. Returns ``None`` when
        capture_prompts is off. Never raises."""
        if not self._capture_prompts:
            return None
        try:
            from datetime import datetime

            from flightdeck_sensor.core.types import EventType

            sent = self._sent.request if self._sent is not None else None
            if sent is None:
                _warn_once("request")
                return None
            now = datetime.now(UTC).isoformat()
            model = self.get_model(request_kwargs)
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
                    input=_embedding_inputs(sent),
                    embedding_output=vectors,
                )
            return PromptContent(
                system=_system_parts(sent.get(_SYSTEM_INSTRUCTION)),
                messages=[],
                tools=sent.get(_TOOLS),
                response=self._stored_response(response),
                provider=GOOGLE,
                model=model,
                session_id="",
                event_id="",
                captured_at=now,
                input=sent.get(_CONTENTS),
            )
        except Exception:
            _log.debug("extract_content failed", exc_info=True)
            return None
