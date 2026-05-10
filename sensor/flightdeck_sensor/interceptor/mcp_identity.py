"""MCP server identity primitive — D127 canonical form + fingerprint.

The MCP Protection Policy gates which Model Context Protocol servers
an agent is allowed to talk to. Every gating decision needs a stable
identity for "the same server" across multiple agents, hosts, and
configuration files. This module is the single source of truth for
the canonical URL form and the SHA-256 fingerprint that drives the
policy's per-server resolution.

Identity is the pair ``(URL, name)``. The URL is the security key —
two declarations with the same canonical URL and different names are
the same enforcement target. The name is the display label and the
tamper-evidence axis: when an agent declares a known URL under a new
name, the sensor emits an ``mcp_server_name_changed`` event so
operators can investigate drift, but the policy decision still
resolves on the URL.

The Node twin lives at ``plugin/hooks/scripts/mcp_identity.mjs``.
Both implementations MUST produce byte-identical output for identical
input. The cross-language fixture vector at
``tests/fixtures/mcp_identity_vectors.json`` locks both implementations
against drift; ``sensor/tests/unit/test_mcp_identity.py`` and
``plugin/tests/mcp_identity.test.mjs`` assert the same vectors.

Pure stdlib. No new dependencies. Ships in the core wheel
unconditionally — does NOT depend on the optional ``[mcp]`` extra.

See DECISIONS.md D127 for the full identity-form rationale and
ARCHITECTURE.md "MCP Protection Policy" → "Identity model" for the
contract this module implements.
"""

from __future__ import annotations

import hashlib
import os
import re
from urllib.parse import urlsplit

__all__ = ["canonicalize_url", "fingerprint", "fingerprint_short"]


# Default ports stripped from HTTP canonical form. A declaration of
# ``https://host:443/path`` and ``https://host/path`` produce the same
# fingerprint — the explicit port is cosmetic when it matches the
# scheme default.
_DEFAULT_PORTS = {"http": 80, "https": 443}

# Env-var regex matches ``$VAR`` and ``${VAR}`` shapes. POSIX-style
# only — no tilde expansion (D127 limits resolution to env vars).
# Unresolved variables (not present in os.environ) remain LITERAL in
# the canonical form: ``${MISSING_VAR}`` stays ``${MISSING_VAR}``.
# Keeping unresolved vars literal means a missing env var produces a
# stable fingerprint that doesn't accidentally match another agent's
# empty-string substitution.
_ENV_VAR_RE = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)")

# Whitespace collapse applies globally inside the stdio canonical
# form (Assumption Y locked in step 2). Every run of whitespace
# becomes a single space; leading and trailing whitespace are
# stripped. An arg containing multi-space whitespace collapses by
# design — callers should normalize args before declaring them. This
# is documented in README.md "MCP Protection Policy" →
# "Troubleshooting".
_WHITESPACE_RUN_RE = re.compile(r"\s+")


def _resolve_env_vars(raw: str) -> str:
    """Substitute ``$VAR`` / ``${VAR}`` from os.environ; leave
    unresolved tokens literal."""

    def repl(match: re.Match[str]) -> str:
        name = match.group(1) or match.group(2)
        # ``os.environ.get`` falls back to the original match when
        # the variable is unset, preserving the literal form so
        # missing-env vectors stay deterministic.
        return os.environ.get(name, match.group(0))

    return _ENV_VAR_RE.sub(repl, raw)


def _canonicalize_http(raw: str) -> str:
    """HTTP / HTTPS canonical form (D127):
    - lowercase scheme + host
    - strip default ports (:80 for http, :443 for https)
    - strip trailing slash only at the root
    - preserve path case beyond the root segment
    - drop user-info, fragment, and query entirely
    """
    parts = urlsplit(raw)
    scheme = parts.scheme.lower()
    # ``hostname`` is already lowercase and excludes user-info.
    host = (parts.hostname or "").lower()
    port = parts.port

    netloc = host
    if port is not None and _DEFAULT_PORTS.get(scheme) != port:
        netloc = f"{host}:{port}"

    path = parts.path or ""
    # Strip trailing slash only at the root. ``/api/`` keeps its
    # slash because path semantics carry beyond root.
    if path == "/":
        path = ""

    # Drop user-info (already excluded by hostname/port pulls),
    # fragment, and query by reconstructing manually.
    return f"{scheme}://{netloc}{path}"


def _canonicalize_stdio(raw: str) -> str:
    """Stdio canonical form (D127):
    - ``stdio://`` scheme prefix
    - literal command + args with single-space separators after
      collapsing internal whitespace runs
    - env-var resolution at fingerprint time (``$VAR``, ``${VAR}``;
      unresolved tokens stay literal)
    - case-sensitive args (file paths and flags carry byte-for-byte)
    """
    body = raw
    if body.lower().startswith("stdio://"):
        body = body[len("stdio://") :]

    body = _resolve_env_vars(body)
    # Whitespace runs collapsed to single space globally; leading
    # and trailing whitespace stripped.
    body = _WHITESPACE_RUN_RE.sub(" ", body).strip()

    return f"stdio://{body}"


def canonicalize_url(raw: str) -> str:
    """Reduce ``raw`` to its canonical form per D127.

    HTTP / HTTPS URLs route to the HTTP canonicalisation. Anything
    else routes to the stdio canonicalisation, which prepends
    ``stdio://`` if missing. The lenient default lets callers pass a
    bare ``"npx -y package"`` command and still get a deterministic
    fingerprint without learning the scheme convention.

    Never raises on input. An empty string returns ``"stdio://"``;
    a string consisting only of whitespace returns ``"stdio://"``.
    Callers that want to reject empty inputs should validate before
    calling.
    """
    if not isinstance(raw, str):
        raise TypeError(f"raw must be str, got {type(raw).__name__}")

    lower = raw.lower()
    if lower.startswith(("http://", "https://")):
        return _canonicalize_http(raw)
    return _canonicalize_stdio(raw)


def fingerprint(canonical_url: str, name: str) -> str:
    """Full 64-character hex SHA-256 of ``canonical_url + 0x00 + name``.

    The 0x00 separator prevents collisions between
    ``("https://a.com", "bservice")`` and
    ``("https://a.combservice", "")`` — without a non-printable
    separator a plain concatenation hash collides on those.
    """
    if not isinstance(canonical_url, str):
        raise TypeError("canonical_url must be str")
    if not isinstance(name, str):
        raise TypeError("name must be str")

    payload = (canonical_url + "\0" + name).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def fingerprint_short(canonical_url: str, name: str) -> str:
    """First 16 hex characters of :func:`fingerprint` — the display
    fingerprint surfaced in the dashboard and in policy entries.
    """
    return fingerprint(canonical_url, name)[:16]
