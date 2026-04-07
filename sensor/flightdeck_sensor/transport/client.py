"""HTTP transport to the Flightdeck control plane.

Uses only the Python standard library (``urllib.request``).
No ``requests``, no ``httpx`` -- zero required dependencies.
"""

from __future__ import annotations

import json
import logging
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

    def post_heartbeat(self, session_id: str) -> Directive | None:
        """POST a heartbeat to ``/v1/heartbeat``."""
        return self._post("/v1/heartbeat", {"session_id": session_id})

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
        """Extract a :class:`Directive` from the response envelope, if present."""
        raw = body.get("directive")
        if raw is None:
            return None
        try:
            return Directive(
                action=DirectiveAction(raw["action"]),
                reason=raw.get("reason", ""),
                grace_period_ms=raw.get("grace_period_ms", 5000),
            )
        except (KeyError, ValueError) as exc:
            _log.warning("Malformed directive in response: %s (%s)", raw, exc)
            return None
