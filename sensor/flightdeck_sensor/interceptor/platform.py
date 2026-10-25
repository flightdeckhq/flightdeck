"""Endpoint attribution shared by the SDK interceptors.

Every ``post_call`` names the endpoint the client talked to under
``provider_metadata.platform``: a fixed label for the hosts the SDKs'
own client classes default to, else the bare host of whatever the client
was pointed at (a gateway, a proxy, a local model server). The worker
copies it into ``events.platform`` and the cost model picks the price
list from it. The host is the only source, so a first-party client
pointed at a gateway reports the gateway rather than a label its class
carries.

A client pointed at a loopback host (``localhost``, ``127.0.0.0/8``,
``::1``) is a self-hosted model server, whose calls carry the ``local``
billing mode.
"""

from __future__ import annotations

import contextlib
import ipaddress
import logging
from dataclasses import dataclass
from typing import Any

_log = logging.getLogger("flightdeck_sensor.interceptor.platform")

PLATFORM_ANTHROPIC = "anthropic"
PLATFORM_OPENAI = "openai"
PLATFORM_AZURE = "azure"
PLATFORM_VERTEX = "vertex"
# The platform of a client pointed at this machine, whatever spelling of
# the loopback host it uses (an IPv6 literal would otherwise fail the
# hostname check below and read as invalid-host).
PLATFORM_LOCALHOST = "localhost"

# Hosts the SDKs' own client classes default to, mapped to the platform
# name reported on the event: (host prefix, host suffix, platform). The
# first matching row wins. A host that matches no row -- a gateway or a
# proxy the caller pointed the SDK at -- is reported verbatim, so the
# deployment topology stays visible instead of being mislabelled as the
# provider's own API.
_PLATFORM_HOSTS: tuple[tuple[str, str, str], ...] = (
    # Every suffix starts with a separator so a look-alike such as
    # evilanthropic.com or anthropic.com.evil.example stays bare, and
    # Vertex matches only the Vertex AI API hosts (aiplatform.<...>
    # .googleapis.com and the regional <region>-aiplatform.googleapis.com)
    # and google-cloud only Claude Platform on Google Cloud's gateway
    # (claude.googleapis.com), not every Google API host.
    ("", ".anthropic.com", PLATFORM_ANTHROPIC),
    ("bedrock-runtime.", ".amazonaws.com", "bedrock"),
    ("bedrock-mantle.", ".api.aws", "bedrock-mantle"),
    ("aws-external-anthropic.", ".api.aws", "aws"),
    ("claude.", ".googleapis.com", "google-cloud"),
    ("aiplatform.", ".googleapis.com", PLATFORM_VERTEX),
    ("", "-aiplatform.googleapis.com", PLATFORM_VERTEX),
    ("", ".services.ai.azure.com", "foundry"),
    ("", ".openai.com", PLATFORM_OPENAI),
    ("", ".openai.azure.com", PLATFORM_AZURE),
    ("", ".cognitiveservices.azure.com", PLATFORM_AZURE),
)

# A platform value is one of the names above or a hostname. Hostnames are
# bounded by the DNS limit on a fully qualified name, and only letters,
# digits, dots and hyphens are accepted once lowercased; anything longer
# or containing other characters is reported as PLATFORM_INVALID_HOST,
# so a malformed or hostile base_url cannot put arbitrary bytes into
# every post_call of a session.
_MAX_PLATFORM_HOST_LENGTH = 253
_PLATFORM_HOST_CHARS = frozenset("abcdefghijklmnopqrstuvwxyz0123456789.-")
PLATFORM_INVALID_HOST = "invalid-host"


def platform_for_host(host: str) -> str:
    """The platform name for an API host: a known platform (see
    ``_PLATFORM_HOSTS``), else the host itself when it is a well-formed
    hostname, else :data:`PLATFORM_INVALID_HOST`."""
    lowered = host.lower()
    if (
        not lowered
        or len(lowered) > _MAX_PLATFORM_HOST_LENGTH
        or not set(lowered) <= _PLATFORM_HOST_CHARS
    ):
        return PLATFORM_INVALID_HOST
    for prefix, suffix, platform in _PLATFORM_HOSTS:
        if lowered.startswith(prefix) and lowered.endswith(suffix):
            return platform
    return lowered


def is_loopback_host(host: str) -> bool:
    """Whether an API host is this machine: ``localhost`` (or a name under
    it) or a loopback address. A server elsewhere on a private network is
    not treated as local, since gateways and metered proxies often sit on
    such addresses."""
    lowered = host.lower().strip("[]").rstrip(".")
    if lowered == "localhost" or lowered.endswith(".localhost"):
        return True
    with contextlib.suppress(ValueError):
        address = ipaddress.ip_address(lowered)
        mapped = getattr(address, "ipv4_mapped", None)
        return (mapped or address).is_loopback
    return False


@dataclass(frozen=True)
class Endpoint:
    """Where a client sends its requests: the platform label, and whether
    that is a model server on this machine."""

    platform: str
    local: bool = False


def endpoint_of(client: Any, default_platform: str) -> Endpoint:
    """The endpoint of a client, read from ``client.base_url.host``;
    ``default_platform`` when the client exposes no usable host (a test
    double)."""
    try:
        host = getattr(getattr(client, "base_url", None), "host", None)
        if isinstance(host, str) and host:
            if is_loopback_host(host):
                return Endpoint(platform=PLATFORM_LOCALHOST, local=True)
            return Endpoint(platform=platform_for_host(host))
    except Exception:
        _log.debug("platform attribution failed", exc_info=True)
    return Endpoint(platform=default_platform)
