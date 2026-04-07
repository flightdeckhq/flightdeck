"""Exponential backoff retry for transient HTTP failures."""

from __future__ import annotations

import logging
import time
from typing import Callable, TypeVar
from urllib.error import URLError

_T = TypeVar("_T")

_log = logging.getLogger("flightdeck_sensor.transport.retry")


def with_retry(
    fn: Callable[[], _T],
    *,
    max_attempts: int = 3,
    backoff_base: float = 0.5,
    retryable: tuple[type[BaseException], ...] = (
        ConnectionError,
        TimeoutError,
        URLError,
        OSError,
    ),
) -> _T:
    """Execute *fn* with exponential backoff on transient failures.

    Retries on connection errors, timeouts, and ``URLError``.
    HTTP 5xx responses must be converted to exceptions by the caller
    before reaching this function.

    Raises the final exception unchanged after *max_attempts* failures.
    """
    last_exc: BaseException | None = None
    for attempt in range(max_attempts):
        try:
            return fn()
        except retryable as exc:
            last_exc = exc
            if attempt < max_attempts - 1:
                delay = backoff_base * (2**attempt)
                _log.warning(
                    "Transient failure (attempt %d/%d), retrying in %.1fs: %s",
                    attempt + 1,
                    max_attempts,
                    delay,
                    exc,
                )
                time.sleep(delay)
    # Should never reach here without last_exc being set, but mypy needs the assert.
    assert last_exc is not None
    raise last_exc
