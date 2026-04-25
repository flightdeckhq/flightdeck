"""Exponential backoff retry for transient HTTP failures."""

from __future__ import annotations

import logging
import time
from typing import Callable, TypeVar
from urllib.error import URLError

_T = TypeVar("_T")

_log = logging.getLogger("flightdeck_sensor.transport.retry")

# Phase 4.5 M-7: tighten retry budget so the event-drain thread (the
# only background thread in the sensor, per Rule 32) is not blocked
# for >0.25s on transient failures. Worst-case blocking is one sleep
# of ``_DEFAULT_BACKOFF_BASE`` between two attempts. Pre-fix this was
# 3 attempts with 0.5s base → up to 1.5s blocked, long enough to fill
# the 1000-slot event queue under hot-path emission and start
# dropping events. Tighter budget fails fast, drops fewer events
# in steady-state failure conditions.
_DEFAULT_MAX_ATTEMPTS = 2
_DEFAULT_BACKOFF_BASE = 0.25


def with_retry(
    fn: Callable[[], _T],
    *,
    max_attempts: int = _DEFAULT_MAX_ATTEMPTS,
    backoff_base: float = _DEFAULT_BACKOFF_BASE,
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
    # Unreachable: the loop either returns or sets ``last_exc`` and
    # falls through. M-6 rationale: explicit RuntimeError rather than
    # ``assert`` so behaviour is stable under ``python -O``.
    if last_exc is None:
        raise RuntimeError("with_retry exhausted attempts without recording an exception")
    raise last_exc
