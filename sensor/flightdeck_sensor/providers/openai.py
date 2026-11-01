"""OpenAI provider: token estimation and usage extraction.

Reimplements the patterns from tokencap -- this is a standalone
implementation with no dependency on tokencap.
"""

from __future__ import annotations

import contextlib
import logging
from datetime import UTC
from typing import Any

from flightdeck_sensor.core.errors import REQUEST_ID_MAX_LEN
from flightdeck_sensor.core.types import CallDetails, TokenUsage
from flightdeck_sensor.providers.protocol import (
    PromptContent,
    StreamAccumulator,
    ToolInvocation,
    finish_reason_of,
)

_log = logging.getLogger("flightdeck_sensor.providers.openai")

_TOKENS_PER_MESSAGE = 4
_TOKENS_REPLY_PRIMING = 2
_CHARS_PER_TOKEN_ESTIMATE = 4

# Token allowance per binary input payload (an inline ``data:`` URL or a
# ``file_data`` body) in a request. OpenAI prices an image input by its
# detail level rather than by its bytes (up to about 1,100 tokens at high
# detail on the 4o-class models), so the payload is dropped from the text
# count and this allowance is added per payload instead; counted as text,
# a 2 MB image would estimate as hundreds of thousands of tokens and could
# trip a policy limit before the call.
_BINARY_INPUT_TOKEN_ALLOWANCE = 1_000
# A base64 data URL opens with ``data:<media type>[;parameter]*;base64,``.
# The media type and its parameters are short, so the ``;base64,`` marker
# sits within this many characters of the start; prose that merely begins
# with "data:" has no marker there and is counted as the text it is.
_DATA_URL_PREFIX = "data:"
_DATA_URL_BASE64_MARKER = ";base64,"
_DATA_URL_HEADER_MAX_CHARS = 100
_BINARY_INPUT_KEYS = frozenset({"file_data"})


def _try_tiktoken_count(messages: list[Any], model: str) -> int | None:
    """Attempt to count tokens using tiktoken if installed.

    Returns ``None`` if tiktoken is unavailable or fails.
    """
    try:
        import tiktoken

        try:
            enc = tiktoken.encoding_for_model(model)
        except KeyError:
            enc = tiktoken.get_encoding("cl100k_base")

        total = 0
        for msg in messages:
            # Per-message overhead (role, content separators)
            total += _TOKENS_PER_MESSAGE
            if isinstance(msg, dict):
                for value in msg.values():
                    total += len(enc.encode(str(value)))
        total += _TOKENS_REPLY_PRIMING  # reply priming
        return total
    except Exception:
        return None


# Responses API events after which no further output arrives.
_RESPONSES_TERMINAL_EVENTS = frozenset(
    {"response.completed", "response.incomplete", "response.failed"}
)

# Responses API output items that are tool calls the model issued, keyed
# by their ``type``. Every one emits a ``tool_call`` event. Messages,
# reasoning items, tool *outputs* (``*_output``) and MCP bookkeeping items
# (``mcp_list_tools``, ``mcp_approval_request`` / ``_response``) are not
# calls and emit nothing.
#
# Named calls carry the tool's own name (a function, an MCP server tool or
# a custom tool). Hosted tools (web search, file search, code interpreter,
# image generation, computer use, shells, apply-patch, tool search) have no
# per-call name, so the item ``type`` is the ``tool_name`` -- the
# provider's own vocabulary, preserved verbatim.
_RESPONSES_NAMED_CALL_TYPES = frozenset({"function_call", "mcp_call", "custom_tool_call"})

# Hosted tool call ``type`` -> (the attribute that carries what the model
# asked the tool to do, the fields of it that are that request). Only the
# listed fields are captured as the ``tool_call`` input; an empty field
# set means the attribute is the input itself (a list of queries, the
# code, the tool-search arguments). Everything else on an item or its
# action is not input: a web search action's ``sources`` are the search
# results, a local shell action's ``env`` is the environment the command
# runs with, a computer call's ``pending_safety_checks`` are the
# provider's verdicts, and tool results (``image_generation_call.result``
# is base64 image data, ``code_interpreter_call.outputs``,
# ``file_search_call.results``, ``mcp_call.output`` / ``error``) are
# outputs. ``image_generation_call`` carries no input at all: the prompt
# lives in the conversation, not on the item.
_RESPONSES_HOSTED_INPUT_FIELDS: dict[str, tuple[str, frozenset[str]] | None] = {
    "web_search_call": ("action", frozenset({"type", "query", "queries", "url", "pattern"})),
    "file_search_call": ("queries", frozenset()),
    "code_interpreter_call": ("code", frozenset()),
    "image_generation_call": None,
    "computer_call": (
        "action",
        frozenset({"type", "button", "x", "y", "keys", "path", "scroll_x", "scroll_y", "text"}),
    ),
    "local_shell_call": (
        "action",
        frozenset({"type", "command", "working_directory", "timeout_ms", "user"}),
    ),
    "shell_call": ("action", frozenset({"commands", "timeout_ms", "max_output_length"})),
    "apply_patch_call": ("operation", frozenset({"type", "path", "diff"})),
    "tool_search_call": ("arguments", frozenset()),
}


# The Responses output item a provider-hosted MCP call lands as, and the
# field naming the MCP server it went to.
_RESPONSES_MCP_CALL = "mcp_call"
_RESPONSES_MCP_SERVER_FIELD = "server_label"
# Where the SDK's ResponseStreamState keeps the snapshot its handle_event
# builds: a private, name-mangled attribute (the state has no public
# accessor; only the SDK's own helper reads it). Pinned by a unit test so
# an SDK rename shows up as a failing test, not as silently absent content.
_RESPONSE_STATE_SNAPSHOT_ATTR = "_ResponseStreamState__current_snapshot"


class _ChatStreamAccumulator:
    """Assembles a raw chat completion stream with the SDK's own
    ``ChatCompletionStreamState``, the state the ``chat.completions
    .stream()`` helper keeps. Its ``current_completion_snapshot`` is the
    completion as a non-streamed call returns it (every choice's message
    content and tool calls, finish reasons, usage); it is used rather
    than ``get_final_completion()``, which raises for a ``length`` or
    ``content_filter`` finish that the post_call still has to report."""

    def __init__(self) -> None:
        from openai.lib.streaming.chat import ChatCompletionStreamState

        self._state: Any = ChatCompletionStreamState()
        self._started = False

    def add(self, chunk: Any) -> None:
        self._state.handle_chunk(chunk)
        self._started = True

    def message(self) -> Any | None:
        return self._state.current_completion_snapshot if self._started else None


class _ResponsesStreamAccumulator:
    """Assembles a raw Responses event stream. The terminal event
    (``response.completed``, ``.incomplete`` or ``.failed``) carries the
    whole ``Response``, which is the message. Before it, and only when
    ``partial`` (content capture on), the SDK's ``ResponseStreamState``
    -- the state the ``responses.stream()`` helper keeps -- folds the
    deltas into a snapshot, which is what an early exit stores."""

    def __init__(self, partial: bool) -> None:
        self._final: Any = None
        self._state: Any = None
        if partial:
            import openai
            from openai.lib.streaming.responses import ResponseStreamState

            # The SDK's "not given" sentinel: ``omit`` on current SDKs,
            # ``NOT_GIVEN`` on older ones; neither tools nor a text format
            # are parsed here.
            unset: Any = getattr(openai, "omit", openai.NOT_GIVEN)
            self._state = ResponseStreamState(input_tools=unset, text_format=unset)

    def add(self, event: Any) -> None:
        if self._final is not None:
            return
        if getattr(event, "type", None) in _RESPONSES_TERMINAL_EVENTS:
            self._final = getattr(event, "response", None)
            return
        if self._state is not None:
            # handle_event is the helper's own entry point; it is the one
            # that keeps the snapshot (accumulate_event only returns it).
            # An event the state cannot fold (one that arrives before the
            # item it belongs to) ends the partial snapshot only: the
            # terminal event still carries the whole response.
            try:
                self._state.handle_event(event)
            except Exception as exc:
                # Class name only: the exception text can echo the event.
                _log.debug("responses partial snapshot dropped (%s)", type(exc).__name__)
                self._state = None

    def message(self) -> Any | None:
        if self._final is not None:
            return self._final
        # The state exposes its snapshot only to the helper; an SDK that
        # renames the attribute leaves an early exit with no partial
        # response stored, never a wrong one.
        return getattr(self._state, _RESPONSE_STATE_SNAPSHOT_ATTR, None)


def _raw_stream_classes() -> tuple[type, ...]:
    """The SDK's raw stream classes (``Stream`` / ``AsyncStream``), empty
    when the SDK is not importable."""
    try:
        import openai

        return (openai.Stream, openai.AsyncStream)
    except Exception:
        return ()


def _jsonable(value: Any) -> Any:
    """``value`` as plain JSON data: unchanged when it already is, else
    with every SDK model in it dumped the way the session dumps framework
    state (a Responses ``input`` often carries the previous response's
    output items, which are SDK models). ``None`` when it cannot be
    encoded at all."""
    import json as _json

    try:
        _json.dumps(value)
        return value
    except (TypeError, ValueError):
        pass
    from flightdeck_sensor.core.session import _json_default

    try:
        return _json.loads(_json.dumps(value, default=_json_default))
    except Exception:
        return None


def _field(obj: Any, name: str) -> Any:
    """Attribute or dict key ``name`` of ``obj``; ``None`` when absent."""
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


# The platforms where the OpenAI SDK reaches OpenAI's own models.
_OPENAI_PLATFORMS = frozenset({"openai", "azure"})


def _reasoning_tokens(usage: Any, details_attr: str) -> int | None:
    """The reasoning share of the output under the usage's details object
    (chat: ``completion_tokens_details``, Responses:
    ``output_tokens_details``), or ``None`` when not reported. Never
    raises."""
    try:
        count = _field(_field(usage, details_attr), "reasoning_tokens")
        # bool is an int subclass; a True count is malformed, not 1.
        if isinstance(count, int) and not isinstance(count, bool) and count >= 0:
            return count
    except Exception:
        pass
    return None


def _openai_details(obj: Any) -> CallDetails | None:
    """The served model and service tier an OpenAI response object (or
    chat chunk) names, or ``None`` when it names neither."""
    model = _field(obj, "model")
    tier = _field(obj, "service_tier")
    details = CallDetails(
        model_served=model if isinstance(model, str) and model else None,
        service_tier=tier if isinstance(tier, str) and tier else None,
    )
    return None if details == CallDetails() else details


def _cache_detail(usage: Any, details_attr: str, field: str) -> int:
    """A cache count under the usage's details object (chat:
    ``prompt_tokens_details``, Responses: ``input_tokens_details``), or
    ``0`` when the provider sent no breakdown.

    ``field`` is ``cached_tokens`` (the prompt-cache read) or
    ``cache_write_tokens`` (the tokens written to the cache, which
    current SDKs report and newer models bill). OpenAI counts both inside
    ``prompt_tokens`` / ``input_tokens`` already, which matches the
    ``TokenUsage`` contract that the cache breakdown is a subset of
    ``input_tokens``. Never raises.
    """
    try:
        count = _field(_field(usage, details_attr), field)
        # bool is an int subclass; a True count is malformed, not 1.
        if isinstance(count, int) and not isinstance(count, bool) and count > 0:
            return count
    except Exception:
        pass
    return 0


def _decode_arguments(args_raw: Any) -> dict[str, Any]:
    """A tool call's arguments as a dict: JSON-decoded when the provider
    sent the JSON string it always does, passed through when already a
    dict, empty when neither decodes to an object."""
    import json as _json

    if isinstance(args_raw, dict):
        return args_raw
    if isinstance(args_raw, str) and args_raw:
        with contextlib.suppress(Exception):
            decoded = _json.loads(args_raw)
            if isinstance(decoded, dict):
                return decoded
    return {}


def _hosted_tool_input(item: Any, item_type: str) -> dict[str, Any]:
    """The input of a hosted tool call item as a dict (``{}`` when the
    item carries none): the allowlisted fields of the item's request
    attribute, see :data:`_RESPONSES_HOSTED_INPUT_FIELDS`."""
    spec = _RESPONSES_HOSTED_INPUT_FIELDS.get(item_type)
    if spec is None:
        return {}
    attr, fields = spec
    value = _field(item, attr)
    if value is None:
        return {}
    if not fields:
        if attr == "arguments":
            return _decode_arguments(value)
        return {attr: value}
    dumped: Any = value if isinstance(value, dict) else None
    if dumped is None:
        dump = getattr(value, "model_dump", None)
        if callable(dump):
            with contextlib.suppress(Exception):
                # Only what the model set: the SDK's action models carry
                # every variant's optional field as None otherwise.
                dumped = dump(exclude_none=True)
    if not isinstance(dumped, dict):
        return {}
    return {key: item_value for key, item_value in dumped.items() if key in fields}


def _responses_input_as_messages(request_kwargs: dict[str, Any]) -> list[Any]:
    """Chat-shaped messages for a Responses API request so the estimator
    counts ``instructions`` and ``input`` (a string or a list of input
    items) the way it counts chat messages. Empty for a request that
    carries neither."""
    out: list[Any] = []
    instructions = request_kwargs.get("instructions")
    if isinstance(instructions, str) and instructions:
        out.append({"role": "system", "content": instructions})
    inp = request_kwargs.get("input")
    if isinstance(inp, str):
        out.append({"role": "user", "content": inp})
    elif isinstance(inp, (list, tuple)):
        for item in inp:
            out.append(item if isinstance(item, dict) else {"role": "user", "content": str(item)})
    return out


def _is_base64_data_url(value: str) -> bool:
    """Whether a string is an inline base64 data URL (see
    :data:`_DATA_URL_HEADER_MAX_CHARS`)."""
    return (
        value.startswith(_DATA_URL_PREFIX)
        and _DATA_URL_BASE64_MARKER in value[:_DATA_URL_HEADER_MAX_CHARS]
    )


def _without_binary_payloads(value: Any) -> tuple[Any, int]:
    """``value`` with every inline binary payload (a base64 data URL
    string, a ``file_data`` body) replaced by an empty string, and the
    number of payloads removed. Containers are copied; everything else is
    returned as is."""
    if isinstance(value, str):
        return ("", 1) if _is_base64_data_url(value) else (value, 0)
    if isinstance(value, dict):
        out: dict[Any, Any] = {}
        removed = 0
        for key, item in value.items():
            if key in _BINARY_INPUT_KEYS and isinstance(item, str):
                out[key] = ""
                removed += 1
                continue
            out[key], n = _without_binary_payloads(item)
            removed += n
        return out, removed
    if isinstance(value, (list, tuple)):
        items: list[Any] = []
        removed = 0
        for item in value:
            cleaned, n = _without_binary_payloads(item)
            items.append(cleaned)
            removed += n
        return items, removed
    return value, 0


def _clamped_request_id(value: Any) -> str | None:
    """A request id bounded to ``REQUEST_ID_MAX_LEN``; ``None`` when the
    value is not a non-empty string."""
    if isinstance(value, str) and value:
        return value[:REQUEST_ID_MAX_LEN]
    return None


# A Responses call the API left unfinished; ``incomplete_details.reason``
# says whether the content filter or ``max_output_tokens`` stopped it.
_RESPONSES_STATUS_INCOMPLETE = "incomplete"
# The Responses stream event that announces the same outcome.
_RESPONSES_INCOMPLETE_EVENT = "response.incomplete"


class OpenAIProvider:
    """Provider adapter for the OpenAI Python SDK.

    All methods are safe to call on the hot path.  None of them raise
    exceptions -- failures return zero/empty defaults.
    """

    name = "openai"

    def __init__(
        self,
        capture_prompts: bool = False,
        platform: str | None = None,
        *,
        local: bool = False,
    ) -> None:
        self._capture_prompts = capture_prompts
        # The endpoint the client talks to (openai, azure, or the host
        # of an OpenAI-compatible server), reported under
        # provider_metadata.platform. None when the caller attributed
        # none.
        self._platform = platform
        self._local = local

    @property
    def platform(self) -> str | None:
        return self._platform

    @property
    def vendor(self) -> str | None:
        # The OpenAI SDK also talks to OpenAI-compatible servers that
        # serve other vendors' models; only OpenAI's own API and Azure
        # OpenAI settle the vendor.
        return "openai" if self._platform in _OPENAI_PLATFORMS else None

    @property
    def local(self) -> bool:
        return self._local

    @property
    def inference_scope(self) -> str | None:
        return None

    def estimate_tokens(self, request_kwargs: dict[str, Any]) -> tuple[int, str]:
        """Estimate input tokens; returns ``(count, source)``.

        Source is ``"tiktoken"`` for the tokeniser path, ``"heuristic"``
        for the char/4 fallback, or ``"none"`` when extraction fails.
        """
        try:
            messages = request_kwargs.get("messages") or _responses_input_as_messages(
                request_kwargs
            )
            # Inline images and file bodies are priced by the provider at
            # a fixed allowance each, not by their bytes.
            messages, binary_payloads = _without_binary_payloads(messages)
            allowance = binary_payloads * _BINARY_INPUT_TOKEN_ALLOWANCE
            model = request_kwargs.get("model", "")

            count = _try_tiktoken_count(messages, model)
            if count is not None:
                return count + allowance, "tiktoken"

            tools = request_kwargs.get("tools", [])
            text = str(messages) + str(tools)
            return len(text) // _CHARS_PER_TOKEN_ESTIMATE + allowance, "heuristic"
        except Exception:
            return 0, "none"

    def extract_response_metadata(self, response: Any) -> dict[str, Any] | None:
        """The header metadata below plus the platform this provider was
        attributed to, which is reported whether or not the response
        exposes any header."""
        out = self._header_metadata(response) or {}
        if self._platform:
            out = {"platform": self._platform, **out}
        return out or None

    def _header_metadata(self, response: Any) -> dict[str, Any] | None:
        """Pull rate-limit headers + processing-ms from raw-response paths.

        OpenAI surfaces these on ``response.headers`` for raw-response
        wrappers (``with_raw_response``). A parsed object (``ChatCompletion``,
        ``Response``, their ``Parsed*`` subclasses, embeddings) exposes no
        headers, but the SDK stamps the ``x-request-id`` header on it as
        ``_request_id``, so the request id is reported on that path too.
        Best-effort: returns ``None`` when nothing useful is reachable.
        """
        try:
            obj = response
            with contextlib.suppress(Exception):
                if hasattr(obj, "parse") and callable(obj.parse):
                    obj = obj.parse()
            headers: Any = None
            for attr in ("headers", "_headers", "response_headers"):
                headers = getattr(response, attr, None) or getattr(obj, attr, None)
                if headers:
                    break
            if not headers:
                request_id = _clamped_request_id(getattr(obj, "_request_id", None))
                if request_id is not None:
                    return {"request_id": request_id}
                return None
            getter = getattr(headers, "get", None)
            if not callable(getter):
                return None
            mapping = {
                "x-ratelimit-remaining-tokens": "ratelimit_remaining_tokens",
                "x-ratelimit-remaining-requests": "ratelimit_remaining_requests",
                "x-ratelimit-limit-tokens": "ratelimit_limit_tokens",
                "openai-processing-ms": "processing_ms",
                "x-request-id": "request_id",
            }
            out: dict[str, Any] = {}
            for src, dst in mapping.items():
                val = getter(src)
                if val is None:
                    continue
                if dst.endswith(("_tokens", "_requests", "_ms")):
                    try:
                        out[dst] = int(val)
                    except (ValueError, TypeError):
                        out[dst] = val
                elif dst == "request_id":
                    clamped = _clamped_request_id(val)
                    if clamped is not None:
                        out[dst] = clamped
                else:
                    out[dst] = val
            return out or None
        except Exception:
            return None

    def extract_output_dimensions(self, response: Any) -> dict[str, int] | None:
        """For embeddings.create() responses: return ``{count, dimension}``."""
        try:
            obj = response
            with contextlib.suppress(Exception):
                if hasattr(obj, "parse") and callable(obj.parse):
                    obj = obj.parse()
            data = getattr(obj, "data", None) or (
                obj.get("data") if isinstance(obj, dict) else None
            )
            if not data:
                return None
            count = len(data)
            first = data[0]
            embedding = getattr(first, "embedding", None) or (
                first.get("embedding") if isinstance(first, dict) else None
            )
            if not embedding:
                return None
            return {"count": count, "dimension": len(embedding)}
        except Exception:
            return None

    def extract_usage(self, response: Any) -> TokenUsage:
        """Extract actual token counts from an OpenAI response.

        Handles three response shapes:

        * Chat completions -- ``usage.prompt_tokens`` /
          ``usage.completion_tokens``.
        * Responses API (``client.responses.create``) --
          ``usage.input_tokens`` / ``usage.output_tokens``. This is the
          new OpenAI API introduced in March 2025 and the recommended
          path for all new projects.
        * Embeddings (``client.embeddings.create``) --
          ``usage.prompt_tokens`` only (no completion counterpart);
          the chat path is re-used and returns ``(prompt_tokens, 0)``,
          which is semantically correct -- embeddings produce vectors,
          not output text.

        Chat-shape fields are read first so the hot path for
        ``chat.completions.create`` stays unchanged. The Responses API
        fields are only consulted when the chat fields are absent.
        Returns ``TokenUsage(0, 0)`` on any failure -- never raises.
        """
        try:
            obj = response
            # Handle raw response wrappers
            if hasattr(obj, "parse") and callable(obj.parse):
                with contextlib.suppress(Exception):
                    obj = obj.parse()

            usage = getattr(obj, "usage", None)
            if usage is None:
                return TokenUsage(input_tokens=0, output_tokens=0)
            return self._usage_from_object(usage)
        except Exception:
            return TokenUsage(input_tokens=0, output_tokens=0)

    def _usage_from_object(self, usage: Any) -> TokenUsage:
        """Read either usage shape (chat ``prompt_tokens`` /
        ``completion_tokens`` or Responses ``input_tokens`` /
        ``output_tokens``) off a usage object. Never raises.

        The prompt-cache read the provider reports under
        ``prompt_tokens_details.cached_tokens`` (chat) or
        ``input_tokens_details.cached_tokens`` (Responses) lands in
        ``cache_read_tokens``, and the cache write under
        ``cache_write_tokens`` in the same objects lands in
        ``cache_creation_tokens`` (``0`` when an older SDK or model sends
        none). The reasoning share of the output
        (``completion_tokens_details.reasoning_tokens`` on chat,
        ``output_tokens_details.reasoning_tokens`` on Responses) lands in
        ``reasoning_tokens``; it is part of ``output_tokens`` already.
        """
        try:
            # ``_field`` so a usage object and a usage dict (the JSON body
            # of a raw response whose parse failed) read the same.
            prompt_tokens = _field(usage, "prompt_tokens") or 0
            completion_tokens = _field(usage, "completion_tokens") or 0

            # Responses API fallback: its usage object uses
            # input_tokens / output_tokens rather than
            # prompt_tokens / completion_tokens. Only consult these
            # when the chat fields were absent so a chat.completions
            # response with a zero prompt_tokens (unlikely but
            # possible) is never silently overwritten.
            if prompt_tokens == 0 and completion_tokens == 0:
                input_tokens = _field(usage, "input_tokens") or 0
                output_tokens = _field(usage, "output_tokens") or 0
                if input_tokens or output_tokens:
                    return TokenUsage(
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cache_read_tokens=_cache_detail(
                            usage, "input_tokens_details", "cached_tokens"
                        ),
                        cache_creation_tokens=_cache_detail(
                            usage, "input_tokens_details", "cache_write_tokens"
                        ),
                        reasoning_tokens=_reasoning_tokens(usage, "output_tokens_details"),
                    )

            return TokenUsage(
                input_tokens=prompt_tokens,
                output_tokens=completion_tokens,
                cache_read_tokens=_cache_detail(usage, "prompt_tokens_details", "cached_tokens"),
                cache_creation_tokens=_cache_detail(
                    usage, "prompt_tokens_details", "cache_write_tokens"
                ),
                reasoning_tokens=_reasoning_tokens(usage, "completion_tokens_details"),
            )
        except Exception:
            return TokenUsage(input_tokens=0, output_tokens=0)

    def usage_from_stream_chunk(self, chunk: Any) -> TokenUsage | None:
        """Usage carried by a streamed OpenAI chunk or event.

        Chat streams carry ``usage`` on the final chunk when the request
        asked for it (the sensor injects ``stream_options.include_usage``);
        Responses streams carry it on ``response.completed`` (and the
        ``incomplete`` / ``failed`` terminal events) under
        ``event.response.usage``.
        """
        try:
            usage = getattr(chunk, "usage", None)
            if usage is None:
                usage = getattr(getattr(chunk, "response", None), "usage", None)
            if usage is None:
                return None
            result = self._usage_from_object(usage)
            return result if result.total > 0 else None
        except Exception:
            return None

    def call_details(self, response: Any) -> CallDetails | None:
        """Served model and service tier from a chat completion, a
        Responses ``Response`` or an embeddings response (or a raw
        wrapper around one)."""
        try:
            obj = response
            if hasattr(obj, "parse") and callable(obj.parse):
                with contextlib.suppress(Exception):
                    obj = obj.parse()
            return _openai_details(obj)
        except Exception:
            return None

    def call_details_from_stream_chunk(self, chunk: Any) -> CallDetails | None:
        """Chat chunks carry ``model`` and ``service_tier`` themselves;
        Responses events carry them on ``event.response``."""
        try:
            if isinstance(getattr(chunk, "type", None), str):
                inner = getattr(chunk, "response", None)
                return _openai_details(inner) if inner is not None else None
            return _openai_details(chunk)
        except Exception:
            return None

    def usage_from_finished_stream(self, stream: Any) -> TokenUsage | None:
        """OpenAI stream objects report nothing after the fact."""
        return None

    def stream_completed(self, stream: Any) -> bool | None:
        """OpenAI stream objects do not track completion."""
        return None

    def final_message(self, stream: Any) -> Any | None:
        """OpenAI stream objects assemble no final message."""
        return None

    def stream_accumulator(
        self, stream: Any, request_kwargs: dict[str, Any]
    ) -> StreamAccumulator | None:
        """An accumulator for a raw chat or Responses stream (a request
        with ``messages`` is a chat call). A chat stream is assembled
        only when something reads the result: content capture, or a
        request that offers the model tools (``tools`` / the legacy
        ``functions``) and so may stream tool calls. The SDK's chat state
        re-serialises the message on every chunk, the price its own
        ``.stream()`` helper pays, so it is not paid for a stream whose
        assembly nothing reads. A Responses stream is assembled always:
        its terminal event already carries the whole response."""
        try:
            classes = _raw_stream_classes()
            if not classes or not isinstance(stream, classes):
                return None
            if "messages" in request_kwargs:
                offers_tools = bool(request_kwargs.get("tools") or request_kwargs.get("functions"))
                if not (self._capture_prompts or offers_tools):
                    return None
                return _ChatStreamAccumulator()
            return _ResponsesStreamAccumulator(partial=self._capture_prompts)
        except Exception:
            _log.debug("stream accumulator unavailable", exc_info=True)
            return None

    def text_from_stream_chunk(self, chunk: Any) -> str | None:
        """OpenAI stream objects have no ``text_stream``."""
        return None

    def chunk_completes_stream(self, chunk: Any) -> bool:
        """A chat chunk carrying ``usage`` (the last one before ``[DONE]``;
        the sensor always asks for it), or a Responses terminal event. The
        ``finish_reason`` chunk is not the end: the usage chunk follows it."""
        try:
            kind = getattr(chunk, "type", None)
            if isinstance(kind, str):
                return kind in _RESPONSES_TERMINAL_EVENTS
            return getattr(chunk, "usage", None) is not None
        except Exception:
            return False

    def extract_content(
        self,
        request_kwargs: dict[str, Any],
        response: Any,
        event_type: Any = None,
    ) -> PromptContent | None:
        """Extract full prompt payload for storage.

        Returns ``None`` when capture_prompts is False. Never raises.
        OpenAI has no separate system field -- system role is in messages.

        When ``event_type == EventType.EMBEDDINGS``
        the request shape is ``{"input": <str | list[str]>, "model":
        ...}`` -- there are no messages, system, tools, or generated
        response content (the response is just an array of vectors,
        which is opaque to operators and not stored). The captured
        ``PromptContent`` carries the input string/list under
        ``input`` and leaves the chat slots empty so the dashboard's
        ``EmbeddingsContentViewer`` can render it distinctly from a
        chat prompt.
        """
        if not self._capture_prompts:
            return None
        try:
            from datetime import datetime

            # Lazy import keeps the typing TYPE_CHECKING contract on
            # ``Provider.extract_content`` honest while letting the
            # runtime branch on the enum value.
            from flightdeck_sensor.core.types import EventType

            now_iso = datetime.now(UTC).isoformat()
            model = request_kwargs.get("model", "")

            if event_type == EventType.EMBEDDINGS:
                # Capture both the input string/list and the raw
                # vectors. ``capture_prompts`` is the single gate;
                # operators get parity between "what did the model
                # see" (input) and "what did it return" (vectors).
                # The events.payload.output_dimensions field carries
                # the {count, dimension} summary so the dashboard can
                # render the shape chip without fetching this body.
                vectors: list[list[float]] | None = None
                try:
                    obj = response
                    with contextlib.suppress(Exception):
                        if hasattr(obj, "parse") and callable(obj.parse):
                            obj = obj.parse()
                    data = getattr(obj, "data", None) or (
                        obj.get("data") if isinstance(obj, dict) else None
                    )
                    if data:
                        vectors = []
                        for entry in data:
                            emb = getattr(entry, "embedding", None) or (
                                entry.get("embedding") if isinstance(entry, dict) else None
                            )
                            if emb is not None:
                                vectors.append(list(emb))
                except Exception:
                    vectors = None
                return PromptContent(
                    system=None,
                    messages=[],
                    tools=None,
                    response={},
                    provider="openai",
                    model=model,
                    session_id="",
                    event_id="",
                    captured_at=now_iso,
                    input=request_kwargs.get("input"),
                    embedding_output=vectors,
                )

            resp_dict: dict[str, Any] = {}
            if hasattr(response, "model_dump"):
                # ``warnings=False``: the SDK's generic ``Parsed*`` models
                # (``parse()`` results) trip pydantic's serializer
                # warnings on every dump, which would surface as
                # UserWarnings in the agent's process.
                try:
                    resp_dict = response.model_dump(warnings=False)
                except TypeError:
                    resp_dict = response.model_dump()
            elif hasattr(response, "__dict__"):
                # Streaming responses surface a ``Stream`` /
                # ``AsyncStream`` whose ``__dict__`` carries the
                # underlying httpx response + async generator, neither
                # JSON-serialisable. Drop any field that fails
                # ``json.dumps`` so the wire payload stays valid for
                # stream calls instead of being rejected by the drain.
                import json as _json

                resp_dict = {}
                for k, v in dict(response.__dict__).items():
                    try:
                        _json.dumps(v)
                    except (TypeError, ValueError):
                        continue
                    resp_dict[k] = v
            else:
                resp_dict = {"raw": str(response)}

            if "messages" not in request_kwargs:
                # A Responses call: its request is ``instructions`` (the
                # top-level system text, stored where Anthropic's
                # ``system`` goes) and ``input`` (a string or a list of
                # input items), stored verbatim under its own name.
                instructions = request_kwargs.get("instructions")
                return PromptContent(
                    system=instructions if isinstance(instructions, str) else None,
                    messages=[],
                    tools=_jsonable(request_kwargs.get("tools")),
                    response=resp_dict,
                    provider="openai",
                    model=model,
                    session_id="",
                    event_id="",
                    captured_at=now_iso,
                    input=_jsonable(request_kwargs.get("input")),
                )

            return PromptContent(
                system=None,  # OpenAI chat embeds system in messages
                messages=request_kwargs.get("messages", []),
                tools=request_kwargs.get("tools"),
                response=resp_dict,
                provider="openai",
                model=model,
                session_id="",  # Filled by caller
                event_id="",  # Filled by caller
                captured_at=now_iso,
            )
        except Exception:
            _log.debug("extract_content failed", exc_info=True)
            return None

    def get_model(self, request_kwargs: dict[str, Any]) -> str:
        """Extract the model name from request kwargs."""
        try:
            model: str = request_kwargs["model"]
            return model
        except (KeyError, TypeError):
            return ""

    def response_stop_reason(self, response: Any) -> str | None:
        """The reason an OpenAI response ended: a chat completion's
        ``choices[0].finish_reason`` (``refusal`` when the structured-output
        ``message.refusal`` is set), or the ``incomplete_details.reason``
        of a Responses call whose ``status`` is ``incomplete``. ``None``
        for a completed Responses call, an embeddings response and any
        shape that carries neither. Raw-response wrappers are parsed
        first."""
        try:
            obj = response
            with contextlib.suppress(Exception):
                if hasattr(obj, "parse") and callable(obj.parse):
                    obj = obj.parse()
            if getattr(obj, "status", None) == _RESPONSES_STATUS_INCOMPLETE:
                details = getattr(obj, "incomplete_details", None)
                reason = getattr(details, "reason", None)
                return reason if isinstance(reason, str) else None
            return finish_reason_of(obj)
        except Exception:
            return None

    def stop_reason_from_stream_chunk(self, chunk: Any) -> str | None:
        """The ``finish_reason`` of a chat chunk that carries one, or the
        ``incomplete_details.reason`` of a Responses ``response.incomplete``
        event; ``None`` for every other chunk or event."""
        try:
            if getattr(chunk, "type", None) == _RESPONSES_INCOMPLETE_EVENT:
                details = getattr(getattr(chunk, "response", None), "incomplete_details", None)
                reason = getattr(details, "reason", None)
                return reason if isinstance(reason, str) else None
            return finish_reason_of(chunk)
        except Exception:
            return None

    def extract_tool_invocations(self, response: Any) -> list[ToolInvocation]:
        """Parse the tool calls the model issued in the response.

        Chat completions: ``response.choices[0].message.tool_calls``
        where each entry has ``type='function'`` and
        ``function.name`` / ``function.arguments`` (JSON string).
        Responses API: the ``response.output`` items that are calls --
        ``function_call``, ``mcp_call``, ``custom_tool_call`` and the
        hosted tools (see :data:`_RESPONSES_HOSTED_INPUT_FIELDS`).
        Returns an empty list on any failure. Never raises.
        """
        try:
            obj = response
            if hasattr(obj, "parse") and callable(obj.parse):
                with contextlib.suppress(Exception):
                    obj = obj.parse()

            choices = getattr(obj, "choices", None)
            if not choices:
                output = getattr(obj, "output", None)
                if isinstance(output, (list, tuple)):
                    return self._responses_tool_invocations(output)
                return []
            first = choices[0]
            message = getattr(first, "message", None) or (
                first.get("message") if isinstance(first, dict) else None
            )
            if message is None:
                return []
            tool_calls = getattr(message, "tool_calls", None) or (
                message.get("tool_calls") if isinstance(message, dict) else None
            )
            if not tool_calls:
                return []

            invocations: list[ToolInvocation] = []
            for tc in tool_calls:
                fn = getattr(tc, "function", None) or (
                    tc.get("function") if isinstance(tc, dict) else None
                )
                if fn is None:
                    continue
                name = getattr(fn, "name", None) or (
                    fn.get("name") if isinstance(fn, dict) else None
                )
                args_raw = getattr(fn, "arguments", None) or (
                    fn.get("arguments") if isinstance(fn, dict) else None
                )
                tool_id = getattr(tc, "id", None) or (
                    tc.get("id") if isinstance(tc, dict) else None
                )
                if not name:
                    continue
                invocations.append(
                    ToolInvocation(
                        name=str(name),
                        tool_input=_decode_arguments(args_raw),
                        tool_id=str(tool_id) if tool_id else None,
                    )
                )
            return invocations
        except Exception:
            _log.debug("extract_tool_invocations failed", exc_info=True)
            return []

    def _responses_tool_invocations(self, output: Any) -> list[ToolInvocation]:
        """One :class:`ToolInvocation` per tool call item in a Responses
        API ``output`` list. Never raises; an item that cannot be read is
        skipped."""
        invocations: list[ToolInvocation] = []
        for item in output:
            try:
                item_type = _field(item, "type")
                if not isinstance(item_type, str):
                    continue
                if item_type in _RESPONSES_NAMED_CALL_TYPES:
                    name = _field(item, "name")
                    if not name:
                        continue
                    if item_type == "custom_tool_call":
                        # A custom tool takes free-form text, not JSON.
                        tool_input: dict[str, Any] = {"input": _field(item, "input")}
                    else:
                        tool_input = _decode_arguments(_field(item, "arguments"))
                    # ``call_id`` pairs the call with its output item, as
                    # a chat tool call's ``id`` does; MCP calls have only
                    # the item id.
                    tool_id = _field(item, "call_id") or _field(item, "id")
                elif item_type in _RESPONSES_HOSTED_INPUT_FIELDS:
                    name = item_type
                    tool_input = _hosted_tool_input(item, item_type)
                    tool_id = _field(item, "id")
                else:
                    continue
                server = (
                    _field(item, _RESPONSES_MCP_SERVER_FIELD)
                    if item_type == _RESPONSES_MCP_CALL
                    else None
                )
                invocations.append(
                    ToolInvocation(
                        name=str(name),
                        tool_input=tool_input,
                        tool_id=str(tool_id) if tool_id else None,
                        server_name=server if isinstance(server, str) and server else None,
                    )
                )
            except Exception as exc:
                # Class name only: the exception text can echo the item.
                _log.debug("responses output item skipped (%s)", type(exc).__name__)
        return invocations
