"""MCP Protection Policy cache + evaluation (D128 / D135).

The sensor fetches the global + flavor MCP policies at session
preflight (alongside the existing token-policy fetch) and caches the
inputs to the D135 resolution algorithm in memory for the session's
lifetime. Per-call ``ClientSession.call_tool`` enforcement consults
this cache, NOT the control plane — Rule 27 forbids latency on the
agent hot path.

Module location is ``core/`` rather than ``interceptor/`` because the
cache + evaluation are policy-state primitives that parallel
``core/policy.py``'s token-budget cache. The MCP interceptor
(``interceptor/mcp.py``) imports this module and calls
:meth:`MCPPolicyCache.evaluate` at the call-tool wrapper site.

D133 soft-launch: the env var ``FLIGHTDECK_MCP_POLICY_DEFAULT``
overrides the configured enforcement at the emit site (NOT here in
the cache). The cache always returns the canonical decision; the
caller decides whether to downgrade ``block`` to ``warn`` based on
the soft-launch toggle. This keeps operator visibility into the
"what would have blocked" data even when enforcement is suppressed.

Fail-open per Rule 28: any HTTP error during preflight produces an
empty cache and ``evaluate`` returns ``allow`` for every URL UNLESS
the agent opted into the local failsafe via
``init(mcp_block_on_uncertainty=True)`` — in which case unmatched
URLs in an empty cache return ``block`` with
``decision_path="mode_default"`` and ``scope="local_failsafe"``.

See DECISIONS.md D127-D135 and ARCHITECTURE.md "MCP Protection
Policy" for the contract this module implements.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Literal

from flightdeck_sensor.interceptor.mcp_identity import (
    canonicalize_url,
    fingerprint_short,
)

__all__ = [
    "MCPPolicyCache",
    "MCPPolicyDecision",
    "soft_launch_default",
    "apply_soft_launch",
]

_log = logging.getLogger("flightdeck_sensor.core.mcp_policy")

# Preflight HTTP timeout. Two calls run sequentially (global +
# flavor); the per-call budget caps the worst-case at 2x this value.
# Matches the 1-second budget the existing token-policy preflight
# uses.
_PREFLIGHT_TIMEOUT_SECS = 1

# Soft-launch env var (D133). Values: "warn" forces warn-only
# regardless of configured enforcement; "enforce" honors configured
# enforcement. v0.6 default is "warn" (this module-level constant);
# v0.7 will flip to "enforce" via a one-line constant change.
_SOFT_LAUNCH_ENV_VAR = "FLIGHTDECK_MCP_POLICY_DEFAULT"
_SOFT_LAUNCH_DEFAULT = "warn"


Decision = Literal["allow", "warn", "block"]
DecisionPath = Literal["flavor_entry", "global_entry", "mode_default"]


@dataclass(frozen=True)
class MCPPolicyDecision:
    """Result of a per-call policy lookup. Mirrors the wire shape of
    ``MCPPolicyResolveResult`` returned by the control plane's
    ``GET /v1/mcp-policies/resolve`` endpoint, so the sensor and the
    plugin can produce byte-identical event payloads from the same
    policy state.
    """

    decision: Decision
    decision_path: DecisionPath
    policy_id: str
    scope: str  # "global" | "flavor:<value>" | "local_failsafe"
    fingerprint: str
    # Set when the decision came from the mode-default fall-through
    # AND the flavor's block_on_uncertainty toggle was true at lookup
    # time. The emit path uses this to populate the
    # ``block_on_uncertainty`` field on POLICY_MCP_BLOCK payloads
    # per D131.
    block_on_uncertainty: bool = False


@dataclass
class _PolicyEntry:
    """In-memory representation of one entry in either the global or
    flavor policy. Fields mirror the API's MCPPolicyEntry shape;
    canonical URL + fingerprint are precomputed at cache populate
    time so per-call lookup is O(1)."""

    fingerprint: str
    server_url_canonical: str
    server_name: str
    entry_kind: str  # "allow" | "deny"
    enforcement: str | None  # "warn" | "block" | "interactive" | None
    policy_id: str  # the policy this entry belongs to
    scope: str  # "global" | "flavor:<value>"


@dataclass
class _PolicyHeader:
    """In-memory representation of a policy's mode + flag state.
    Mirrors the API's MCPPolicy non-entries fields."""

    policy_id: str
    scope: str  # "global" | "flavor"
    scope_value: str | None
    mode: str | None  # "allowlist" | "blocklist" — global only
    block_on_uncertainty: bool


def soft_launch_default() -> str:
    """Return the active soft-launch mode — ``"warn"`` or
    ``"enforce"``. Reads the env var on every call so a runtime
    change (debugging, test fixture) takes effect without sensor
    restart."""
    raw = os.environ.get(_SOFT_LAUNCH_ENV_VAR, _SOFT_LAUNCH_DEFAULT)
    if raw not in ("warn", "enforce"):
        _log.warning(
            "%s=%r is invalid; expected 'warn' or 'enforce'. Using default %r.",
            _SOFT_LAUNCH_ENV_VAR,
            raw,
            _SOFT_LAUNCH_DEFAULT,
        )
        return _SOFT_LAUNCH_DEFAULT
    return raw


def apply_soft_launch(decision: MCPPolicyDecision) -> tuple[Decision, bool]:
    """Apply the soft-launch override to a canonical decision.

    Returns ``(effective_decision, would_have_blocked)``. The flag is
    true exactly when the canonical decision was ``"block"`` AND the
    soft-launch override downgraded it to ``"warn"`` so the emit path
    can stamp ``would_have_blocked=True`` on the synthesized warn
    event payload (per ARCHITECTURE.md sub-section 11).
    """
    if soft_launch_default() == "enforce":
        return decision.decision, False
    # warn-only override: downgrade block to warn; allow + warn pass
    # through unchanged.
    if decision.decision == "block":
        return "warn", True
    return decision.decision, False


class MCPPolicyCache:
    """Thread-safe in-memory cache of the global + flavor MCP
    Protection Policies.

    Lifecycle:

    1. Sensor ``init()`` constructs an empty cache.
    2. Session preflight (``Session._preflight_mcp_policy``) calls
       :meth:`populate_from_control_plane` to fetch the global +
       flavor policies. Failures fail-open (empty cache) per Rule 28.
    3. Per-call ``ClientSession.call_tool`` consults
       :meth:`evaluate`. The lookup is O(1) on a dict keyed by
       fingerprint plus a bounded mode-default fall-through.
    4. ``policy_update`` directives trigger a refresh via
       :meth:`populate_from_control_plane` (the existing directive
       handler in ``Session._apply_directive`` calls into this).

    The ``mcp_block_on_uncertainty`` constructor kwarg is the
    operator failsafe (Assumption 8 / Step 4 plan). When the
    control plane is unreachable AND this flag is true, mode-default
    fall-through resolves to block. Default ``False`` preserves the
    fail-open posture.
    """

    def __init__(self, *, mcp_block_on_uncertainty: bool = False) -> None:
        self._lock = threading.Lock()
        self._populated = False
        self._local_failsafe = mcp_block_on_uncertainty
        # Indexed by fingerprint. flavor entries take precedence at
        # lookup time over global entries (D135 step 1 → step 2);
        # populating the dicts separately keeps that contract clear.
        self._flavor_entries: dict[str, _PolicyEntry] = {}
        self._global_entries: dict[str, _PolicyEntry] = {}
        self._global: _PolicyHeader | None = None
        self._flavor: _PolicyHeader | None = None

    # ------------------------------------------------------------------
    # Populate
    # ------------------------------------------------------------------

    def populate_from_control_plane(
        self,
        api_url: str,
        token: str,
        flavor: str | None,
    ) -> None:
        """Fetch the global + flavor policies from the control plane
        and rebuild the in-memory cache. Best-effort: any HTTP
        failure logs at debug level and leaves the existing cache in
        place (so a transient network blip during a directive-
        triggered refresh doesn't wipe the policy that was already
        loaded successfully).
        """
        new_global: _PolicyHeader | None = None
        new_flavor: _PolicyHeader | None = None
        new_global_entries: dict[str, _PolicyEntry] = {}
        new_flavor_entries: dict[str, _PolicyEntry] = {}

        global_doc = self._fetch_policy(api_url, token, "global")
        if global_doc is not None:
            new_global, new_global_entries = self._parse_policy(global_doc, "global")

        if flavor:
            flavor_doc = self._fetch_policy(api_url, token, flavor)
            if flavor_doc is not None:
                new_flavor, new_flavor_entries = self._parse_policy(flavor_doc, "flavor")

        # Atomic swap so a partial update can't leave the cache in a
        # half-populated state.
        with self._lock:
            self._global = new_global
            self._flavor = new_flavor
            self._global_entries = new_global_entries
            self._flavor_entries = new_flavor_entries
            self._populated = (new_global is not None) or (new_flavor is not None)

    def _fetch_policy(
        self,
        api_url: str,
        token: str,
        scope_segment: str,
    ) -> dict[str, Any] | None:
        url = f"{api_url}/v1/mcp-policies/{scope_segment}"
        req = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {token}"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=_PREFLIGHT_TIMEOUT_SECS) as resp:
                parsed: dict[str, Any] = json.loads(resp.read().decode())
                return parsed
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                # Flavor not configured — legitimate empty result.
                return None
            _log.debug("preflight mcp policy fetch failed: %s %s", scope_segment, exc)
            return None
        except Exception:
            _log.debug("preflight mcp policy fetch errored", exc_info=True)
            return None

    def _parse_policy(
        self,
        doc: dict[str, Any],
        scope_kind: str,
    ) -> tuple[_PolicyHeader, dict[str, _PolicyEntry]]:
        policy_id = str(doc.get("id", ""))
        scope = str(doc.get("scope", scope_kind))
        scope_value = doc.get("scope_value")
        mode = doc.get("mode")
        bou = bool(doc.get("block_on_uncertainty", False))

        header = _PolicyHeader(
            policy_id=policy_id,
            scope=scope,
            scope_value=scope_value if isinstance(scope_value, str) else None,
            mode=mode if isinstance(mode, str) else None,
            block_on_uncertainty=bou,
        )

        entries: dict[str, _PolicyEntry] = {}
        scope_label = "global" if scope == "global" else f"flavor:{scope_value or ''}"
        for raw_entry in doc.get("entries") or []:
            fp = str(raw_entry.get("fingerprint", ""))
            if not fp:
                continue
            entries[fp] = _PolicyEntry(
                fingerprint=fp,
                server_url_canonical=str(raw_entry.get("server_url", "")),
                server_name=str(raw_entry.get("server_name", "")),
                entry_kind=str(raw_entry.get("entry_kind", "allow")),
                enforcement=raw_entry.get("enforcement"),
                policy_id=policy_id,
                scope=scope_label,
            )
        return header, entries

    # ------------------------------------------------------------------
    # Evaluate
    # ------------------------------------------------------------------

    def evaluate(self, server_url: str, server_name: str) -> MCPPolicyDecision:
        """Apply the D135 resolution algorithm to the cached policy.

        Returns the canonical decision; soft-launch downgrade is the
        caller's responsibility (see :func:`apply_soft_launch`).
        """
        canonical = canonicalize_url(server_url)
        fp = fingerprint_short(canonical, server_name)

        with self._lock:
            # Step 1: flavor entry?
            entry = self._flavor_entries.get(fp)
            if entry is not None:
                return _decision_from_entry(entry, "flavor_entry", fp)

            # Step 2: global entry?
            entry = self._global_entries.get(fp)
            if entry is not None:
                return _decision_from_entry(entry, "global_entry", fp)

            # Step 3: mode default.
            return self._mode_default_decision(fp)

    def _mode_default_decision(self, fp: str) -> MCPPolicyDecision:
        """D135 step 3 fall-through. Three sub-cases:

        - cache populated + global allowlist → block
        - cache populated + global blocklist → allow
        - cache empty (preflight failed) + local_failsafe=True → block
        - cache empty + local_failsafe=False → allow (Rule 28 fail-open)
        """
        flavor_bou = self._flavor.block_on_uncertainty if self._flavor else False

        if not self._populated:
            # Cache miss + control plane unreachable. Local failsafe
            # decides; default is fail-open.
            decision: Decision = "block" if self._local_failsafe else "allow"
            return MCPPolicyDecision(
                decision=decision,
                decision_path="mode_default",
                policy_id="",
                scope="local_failsafe" if self._local_failsafe else "fail_open",
                fingerprint=fp,
                block_on_uncertainty=self._local_failsafe,
            )

        global_mode = self._global.mode if self._global else None
        global_id = self._global.policy_id if self._global else ""

        if global_mode == "allowlist":
            scope_attribution = "global"
            if flavor_bou and self._flavor is not None:
                scope_attribution = f"flavor:{self._flavor.scope_value or ''}"
            return MCPPolicyDecision(
                decision="block",
                decision_path="mode_default",
                policy_id=global_id,
                scope=scope_attribution,
                fingerprint=fp,
                block_on_uncertainty=flavor_bou,
            )
        # blocklist mode (or no mode set — treat as permissive)
        return MCPPolicyDecision(
            decision="allow",
            decision_path="mode_default",
            policy_id=global_id,
            scope="global",
            fingerprint=fp,
            block_on_uncertainty=False,
        )

    # ------------------------------------------------------------------
    # Introspection
    # ------------------------------------------------------------------

    def known_servers(self) -> list[tuple[str, str]]:
        """Return ``[(canonical_url, server_name)]`` for every entry
        across both policies. Used by the initialize-time name-drift
        detector in ``interceptor/mcp.py`` to look up the policy's
        registered name for a canonical URL.
        """
        out: list[tuple[str, str]] = []
        with self._lock:
            for entry in self._flavor_entries.values():
                out.append((entry.server_url_canonical, entry.server_name))
            for entry in self._global_entries.values():
                out.append((entry.server_url_canonical, entry.server_name))
        return out

    def lookup_known_name(self, server_url: str) -> str | None:
        """Return the policy-registered server_name for a given raw
        server_url, or None when no policy entry exists for the
        canonical form. Used to drive the
        ``mcp_server_name_changed`` event when the agent's declared
        name disagrees with the policy's recorded name.
        """
        canonical = canonicalize_url(server_url)
        with self._lock:
            for entry in self._flavor_entries.values():
                if entry.server_url_canonical == canonical:
                    return entry.server_name
            for entry in self._global_entries.values():
                if entry.server_url_canonical == canonical:
                    return entry.server_name
        return None

    def is_populated(self) -> bool:
        """True when at least one policy fetch (global or flavor)
        succeeded since the last :meth:`populate_from_control_plane`
        call. Used by the test suite and by the diagnostic
        ``get_status`` path."""
        with self._lock:
            return self._populated


def _decision_from_entry(
    entry: _PolicyEntry,
    decision_path: DecisionPath,
    fingerprint: str,
) -> MCPPolicyDecision:
    if entry.entry_kind == "allow":
        decision: Decision = "allow"
    else:
        # deny entry — enforcement field upgrades bare deny to warn /
        # block. Default for deny without enforcement: block.
        decision = (
            entry.enforcement  # type: ignore[assignment]
            if entry.enforcement in ("warn", "block")
            else "block"
        )
    return MCPPolicyDecision(
        decision=decision,
        decision_path=decision_path,
        policy_id=entry.policy_id,
        scope=entry.scope,
        fingerprint=fingerprint,
        block_on_uncertainty=False,
    )
