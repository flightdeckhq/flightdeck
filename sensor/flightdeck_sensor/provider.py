"""Canonical names of interceptor targets accepted by
:func:`flightdeck_sensor.patch`.

The :class:`Provider` enum is the single source of truth for the
``providers=`` argument to ``patch()``. Each member IS a string
(``Provider.ANTHROPIC == "anthropic"`` evaluates ``True``) so it works
anywhere a raw string was accepted before -- existing user code
that passes ``patch(providers=["anthropic"])`` keeps working without
edits, and a partially-migrated codebase can mix
``patch(providers=[Provider.ANTHROPIC, "openai"])`` cleanly.

Why ``(str, Enum)`` rather than ``StrEnum``: the project supports
Python ``>= 3.10`` (sensor/pyproject.toml requires-python). ``StrEnum``
landed in 3.11. The mixin form gives the same "member IS a string"
semantics on 3.10.
"""
from __future__ import annotations

from enum import Enum


class Provider(str, Enum):
    """Interceptor targets ``flightdeck_sensor.patch()`` knows how to
    install hooks for.

    Members:

    * ``Provider.ANTHROPIC`` — class-level patch on ``anthropic.Anthropic``
      and ``anthropic.AsyncAnthropic``.
    * ``Provider.OPENAI`` — class-level patch on ``openai.OpenAI`` and
      ``openai.AsyncOpenAI``.
    * ``Provider.LITELLM`` — module-level patch on ``litellm.completion``
      and ``litellm.acompletion`` (KI21).
    * ``Provider.MCP`` — class-level patch on
      ``mcp.client.session.ClientSession`` plus the four transport
      factories (Phase 5 / D117).

    Each member's ``.value`` is the canonical string name. The string
    name is what ``patch()`` matches against internally, so passing
    ``Provider.ANTHROPIC`` and passing ``"anthropic"`` are equivalent.
    """

    ANTHROPIC = "anthropic"
    OPENAI = "openai"
    LITELLM = "litellm"
    MCP = "mcp"
