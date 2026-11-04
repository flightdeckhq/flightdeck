"""What the model provider itself answered, read off the HTTP responses of a
capture run, so a recording can be compared with the provider's own usage.

``install()`` wraps the async and sync transports of httpx and httpx2 (the
provider SDKs use one or the other) for this process. For each response
from a model provider it keeps the route, the HTTP status, the ``usage``
object the provider returned (from the JSON body or, for a stream, merged
from its server-sent events) and, for an error, the error's type and
code. Nothing else of the response is kept: no message, no content, no
request or account id. The OTLP exporters send with urllib3, so their
requests are not touched.

A streamed response is read to its end before the SDK gets it, so with
the tap installed a stream's time to first token is about its whole
duration: a recording made with it does not measure that latency.
"""

from __future__ import annotations

import json
from typing import Any

PROVIDER_HOSTS = {"api.anthropic.com", "api.openai.com"}

_CALLS: list[dict[str, Any]] = []


def calls() -> list[dict[str, Any]]:
    """The provider responses seen so far, in order."""
    return list(_CALLS)


def _merge_usage(into: dict[str, Any], usage: Any) -> None:
    if isinstance(usage, dict):
        for key, value in usage.items():
            if value is not None:
                into[key] = value


def _summary(status: int, path: str, body: bytes) -> dict[str, Any]:
    out: dict[str, Any] = {"path": path, "status": status}
    text = body.decode("utf-8", errors="replace")
    docs: list[Any] = []
    try:
        docs.append(json.loads(text))
    except ValueError:
        # A stream: one JSON document per `data:` line.
        for line in text.splitlines():
            if line.startswith("data:"):
                try:
                    docs.append(json.loads(line[5:].strip()))
                except ValueError:
                    continue
    usage: dict[str, Any] = {}
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        _merge_usage(usage, doc.get("usage"))
        # Anthropic streams start with the message and its usage.
        _merge_usage(usage, (doc.get("message") or {}).get("usage"))
        # The Responses API reports usage on the completed response.
        _merge_usage(usage, (doc.get("response") or {}).get("usage"))
        error = doc.get("error")
        if isinstance(error, dict):
            out["error"] = {
                k: error[k] for k in ("type", "code") if error.get(k) is not None
            }
    if usage:
        out["usage"] = usage
    return out


def _wrap(module: Any) -> None:
    async_original = module.AsyncHTTPTransport.handle_async_request
    sync_original = module.HTTPTransport.handle_request

    def rebuilt(response: Any, raw: bytes, request: Any) -> Any:
        decoded = module.Response(
            status_code=response.status_code, headers=response.headers, content=raw
        ).read()
        _CALLS.append(_summary(response.status_code, request.url.path, decoded))
        return module.Response(
            status_code=response.status_code,
            headers=response.headers,
            content=raw,
            extensions=response.extensions,
        )

    async def handle_async_request(self: Any, request: Any) -> Any:
        response = await async_original(self, request)
        if request.url.host not in PROVIDER_HOSTS:
            return response
        raw = b"".join([chunk async for chunk in response.aiter_raw()])
        await response.aclose()
        return rebuilt(response, raw, request)

    def handle_request(self: Any, request: Any) -> Any:
        response = sync_original(self, request)
        if request.url.host not in PROVIDER_HOSTS:
            return response
        raw = b"".join(response.iter_raw())
        response.close()
        return rebuilt(response, raw, request)

    module.AsyncHTTPTransport.handle_async_request = handle_async_request
    module.HTTPTransport.handle_request = handle_request


def install() -> None:
    for name in ("httpx", "httpx2"):
        try:
            module = __import__(name)
        except ImportError:
            continue
        _wrap(module)
