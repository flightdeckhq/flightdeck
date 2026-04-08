"""HTTP transport to the Flightdeck control plane.

Uses only the Python standard library (``urllib.request``).
No ``requests``, no ``httpx`` -- zero required dependencies.
"""

from __future__ import annotations

import contextlib
import json
import logging
import queue
import threading
import time
import urllib.request
from typing import Any
from urllib.error import HTTPError, URLError

from flightdeck_sensor.core.exceptions import DirectiveError
from flightdeck_sensor.core.types import Directive, DirectiveAction
from flightdeck_sensor.transport.retry import with_retry

_log = logging.getLogger("flightdeck_sensor.transport.client")

_TIMEOUT_SECS = 10


class ControlPlaneClient:
    """Fire-and-forget HTTP client for sensor → control plane communication.

    On connectivity failure the behaviour depends on *unavailable_policy*:

    * ``"continue"`` -- log a warning, return ``None``, agent proceeds.
    * ``"halt"`` -- raise :class:`DirectiveError`, agent must stop.
    """

    def __init__(
        self,
        server: str,
        token: str,
        unavailable_policy: str = "continue",
    ) -> None:
        self._base_url = server.rstrip("/")
        self._token = token
        self._unavailable_policy = unavailable_policy

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def post_event(self, payload: dict[str, Any]) -> Directive | None:
        """POST an event to ``/v1/events`` and return any embedded directive."""
        return self._post("/v1/events", payload)

    def sync_directives(
        self,
        flavor: str,
        directives: list[dict[str, Any]],
    ) -> list[str]:
        """POST fingerprints to /v1/directives/sync, return unknown fingerprints.

        Each entry in *directives* must have ``name`` and ``fingerprint`` keys.
        Returns a list of fingerprints the server does not recognise.
        On any error, returns an empty list (fail open).
        """
        url = f"{self._base_url}/v1/directives/sync"
        body = json.dumps({"flavor": flavor, "directives": directives}).encode()
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._token}",
            },
            method="POST",
        )
        try:
            from flightdeck_sensor.core.schemas import SyncResponseSchema
            from pydantic import ValidationError

            with urllib.request.urlopen(req, timeout=1) as resp:
                data = json.loads(resp.read().decode())
                try:
                    parsed = SyncResponseSchema.model_validate(data)
                    return parsed.unknown_fingerprints
                except ValidationError:
                    _log.warning("sync response validation failed, returning empty")
                    return []
        except Exception:
            _log.debug("directives sync failed, proceeding without sync", exc_info=True)
            return []

    def register_directives(
        self,
        flavor: str,
        directives: list[dict[str, Any]],
    ) -> None:
        """POST full directive schemas to /v1/directives/register.

        Fire-and-forget: ignores all errors (fail open).
        """
        url = f"{self._base_url}/v1/directives/register"
        body = json.dumps({"flavor": flavor, "directives": directives}).encode()
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._token}",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=1) as resp:
                resp.read()
        except Exception:
            _log.debug("directives register failed, ignoring", exc_info=True)

    def close(self) -> None:
        """No-op -- stdlib ``urllib`` has no persistent connection to close."""

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _post(self, path: str, body: dict[str, Any]) -> Directive | None:
        """POST JSON and parse the response envelope for a directive."""
        url = f"{self._base_url}{path}"
        data = json.dumps(body).encode()
        req = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._token}",
            },
            method="POST",
        )

        try:
            raw = with_retry(lambda: self._do_request(req))
        except (URLError, OSError, TimeoutError, ConnectionError) as exc:
            return self._handle_unavailable(exc)

        return self._parse_directive(raw)

    def _do_request(self, req: urllib.request.Request) -> dict[str, Any]:
        """Execute a single HTTP request and return the parsed JSON body.

        Raises on HTTP 5xx so that :func:`with_retry` can retry.
        HTTP 4xx is a caller bug -- log and return a neutral response.
        """
        try:
            with urllib.request.urlopen(req, timeout=_TIMEOUT_SECS) as resp:
                body: dict[str, Any] = json.loads(resp.read().decode())
                return body
        except HTTPError as exc:
            if exc.code >= 500:
                raise  # let retry handle it
            # 4xx -- caller bug, not retryable
            _log.warning("Control plane returned HTTP %d: %s", exc.code, exc.reason)
            return {"status": "ok", "directive": None}

    def _handle_unavailable(self, exc: BaseException) -> Directive | None:
        """Apply the unavailability policy after exhausting retries."""
        if self._unavailable_policy == "halt":
            raise DirectiveError(
                action="halt",
                reason=f"Control plane unreachable: {exc}",
            )
        _log.warning("Control plane unreachable (policy=continue): %s", exc)
        return None

    @staticmethod
    def _parse_directive(body: dict[str, Any]) -> Directive | None:
        """Extract a :class:`Directive` from the response envelope, if present.

        Uses Pydantic DirectiveResponseSchema for structured validation.
        On ValidationError: log warning and return None (fail open).
        """
        from flightdeck_sensor.core.schemas import DirectiveResponseSchema

        raw = body.get("directive")
        if raw is None:
            return None
        try:
            from pydantic import ValidationError

            try:
                parsed = DirectiveResponseSchema.model_validate(raw)
            except ValidationError as ve:
                _log.warning("Directive validation failed: %s", ve)
                return None

            payload: dict[str, Any] = parsed.payload or {}
            if parsed.degrade_to and "degrade_to" not in payload:
                payload["degrade_to"] = parsed.degrade_to

            return Directive(
                action=DirectiveAction(parsed.action),
                reason=parsed.reason or "",
                grace_period_ms=parsed.grace_period_ms,
                payload=payload,
            )
        except (KeyError, ValueError) as exc:
            _log.warning("Malformed directive in response: %s (%s)", raw, exc)
            return None


# ------------------------------------------------------------------
# Non-blocking event queue
# ------------------------------------------------------------------

_MAX_QUEUE_SIZE = 1000
_SENTINEL = object()


class EventQueue:
    """Non-blocking event queue with background drain thread.

    The interceptor calls :meth:`enqueue` which never blocks.
    A daemon thread drains the queue and calls
    :meth:`ControlPlaneClient.post_event`.
    """

    def __init__(self, client: ControlPlaneClient) -> None:
        self._client = client
        self._queue: queue.Queue[dict[str, Any] | object] = queue.Queue(
            maxsize=_MAX_QUEUE_SIZE,
        )
        self._thread = threading.Thread(
            target=self._drain_loop,
            daemon=True,
            name="flightdeck-event-queue",
        )
        self._thread.start()

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def enqueue(self, payload: dict[str, Any]) -> None:
        """Put *payload* on queue.  Never blocks.  Never raises."""
        try:
            self._queue.put_nowait(payload)
        except queue.Full:
            # Drop oldest, enqueue new
            with contextlib.suppress(queue.Empty):
                self._queue.get_nowait()
            with contextlib.suppress(queue.Full):
                self._queue.put_nowait(payload)
            _log.warning(
                "Event queue full (%d), dropped oldest event",
                _MAX_QUEUE_SIZE,
            )

    def flush(self, timeout: float = 5.0) -> None:
        """Drain remaining items synchronously.  Called on session end."""
        deadline = time.monotonic() + timeout
        while not self._queue.empty() and time.monotonic() < deadline:
            try:
                item = self._queue.get_nowait()
                if item is _SENTINEL:
                    break
                self._client.post_event(item)  # type: ignore[arg-type]
            except queue.Empty:
                break
            except Exception:
                _log.debug("flush post_event failed", exc_info=True)

    def close(self) -> None:
        """Stop the drain thread."""
        self._queue.put(_SENTINEL)
        self._thread.join(timeout=5)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _drain_loop(self) -> None:
        """Background thread: drain queue, post events."""
        while True:
            try:
                item = self._queue.get(timeout=1.0)
            except queue.Empty:
                continue
            if item is _SENTINEL:
                break
            try:
                self._client.post_event(item)  # type: ignore[arg-type]
            except Exception:
                _log.debug("drain post_event failed", exc_info=True)
