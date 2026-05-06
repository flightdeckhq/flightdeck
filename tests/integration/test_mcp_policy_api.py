"""Integration tests for the MCP Protection Policy control-plane API
(D128 / D135). Exercises the full chain: handler → store → Postgres
→ migration 000018. Requires `make dev` to be running with API
boot-time auto-create having executed at least once (D133).

Each test creates an isolated flavor (random UUID) so concurrent
runs don't collide on the (scope, scope_value) uniqueness invariant.
A pytest fixture wipes the test policy at end-of-test best-effort.
"""

from __future__ import annotations

import uuid

import requests

from .conftest import (
    ADMIN_TOKEN,
    API_URL,
    TOKEN,
    admin_auth_headers,
    auth_headers,
)


def _admin_headers(json_body: bool = True) -> dict[str, str]:
    return admin_auth_headers(json_body=json_body)


def _read_headers(json_body: bool = False) -> dict[str, str]:
    return auth_headers(json_body=json_body)


def _unique_flavor() -> str:
    return f"test-mcp-{uuid.uuid4().hex[:8]}"


def _delete_flavor(flavor: str) -> None:
    requests.delete(f"{API_URL}/v1/mcp-policies/{flavor}",
                    headers=_admin_headers(json_body=False), timeout=5)


# ----- read + resolve -----------------------------------------------


def test_global_policy_auto_created_at_boot() -> None:
    """D133: API boot ensures the empty blocklist global policy exists."""
    r = requests.get(f"{API_URL}/v1/mcp-policies/global",
                     headers=_read_headers(), timeout=5)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scope"] == "global"
    assert body["mode"] in ("allowlist", "blocklist")


def test_get_missing_flavor_returns_404() -> None:
    flavor = _unique_flavor()
    r = requests.get(f"{API_URL}/v1/mcp-policies/{flavor}",
                     headers=_read_headers(), timeout=5)
    assert r.status_code == 404, r.text


# ----- write CRUD round-trip ----------------------------------------


def test_full_crud_round_trip() -> None:
    flavor = _unique_flavor()
    try:
        # POST
        body = {
            "block_on_uncertainty": True,
            "entries": [{
                "server_url": "https://maps.example.com/sse",
                "server_name": "maps",
                "entry_kind": "allow",
                "enforcement": "block",
            }],
        }
        r = requests.post(f"{API_URL}/v1/mcp-policies/{flavor}",
                          headers=_admin_headers(), json=body, timeout=5)
        assert r.status_code == 201, r.text
        created = r.json()
        assert created["version"] == 1
        assert len(created["entries"]) == 1

        # GET
        r = requests.get(f"{API_URL}/v1/mcp-policies/{flavor}",
                         headers=_read_headers(), timeout=5)
        assert r.status_code == 200, r.text
        assert r.json()["block_on_uncertainty"] is True

        # PUT — replace entries
        body2 = {
            "block_on_uncertainty": False,
            "entries": [{
                "server_url": "https://search.example.com",
                "server_name": "search",
                "entry_kind": "deny",
                "enforcement": "warn",
            }],
        }
        r = requests.put(f"{API_URL}/v1/mcp-policies/{flavor}",
                         headers=_admin_headers(), json=body2, timeout=5)
        assert r.status_code == 200, r.text
        updated = r.json()
        assert updated["version"] == 2
        assert updated["block_on_uncertainty"] is False

        # DELETE
        r = requests.delete(f"{API_URL}/v1/mcp-policies/{flavor}",
                            headers=_admin_headers(json_body=False), timeout=5)
        assert r.status_code == 204, r.text

        # GET after delete
        r = requests.get(f"{API_URL}/v1/mcp-policies/{flavor}",
                         headers=_read_headers(), timeout=5)
        assert r.status_code == 404
    finally:
        _delete_flavor(flavor)


def test_post_duplicate_flavor_returns_409() -> None:
    flavor = _unique_flavor()
    body = {"block_on_uncertainty": False, "entries": []}
    try:
        r = requests.post(f"{API_URL}/v1/mcp-policies/{flavor}",
                          headers=_admin_headers(), json=body, timeout=5)
        assert r.status_code == 201
        r = requests.post(f"{API_URL}/v1/mcp-policies/{flavor}",
                          headers=_admin_headers(), json=body, timeout=5)
        assert r.status_code == 409
    finally:
        _delete_flavor(flavor)


def test_post_with_mode_on_flavor_rejected() -> None:
    flavor = _unique_flavor()
    body = {
        "mode": "allowlist",  # D134 violation: mode is global-only
        "block_on_uncertainty": False,
        "entries": [],
    }
    try:
        r = requests.post(f"{API_URL}/v1/mcp-policies/{flavor}",
                          headers=_admin_headers(), json=body, timeout=5)
        assert r.status_code == 400
        assert "mode is global-only" in r.text
    finally:
        _delete_flavor(flavor)


# ----- versions + audit log ----------------------------------------


def test_versions_list_grows_with_each_put() -> None:
    flavor = _unique_flavor()
    try:
        body = {"block_on_uncertainty": False, "entries": []}
        requests.post(f"{API_URL}/v1/mcp-policies/{flavor}",
                      headers=_admin_headers(), json=body, timeout=5)
        # Three PUTs → versions 2, 3, 4 in addition to v1 from POST
        for bou in (True, False, True):
            body["block_on_uncertainty"] = bou
            r = requests.put(f"{API_URL}/v1/mcp-policies/{flavor}",
                             headers=_admin_headers(), json=body, timeout=5)
            assert r.status_code == 200
        r = requests.get(f"{API_URL}/v1/mcp-policies/{flavor}/versions",
                         headers=_admin_headers(json_body=False), timeout=5)
        assert r.status_code == 200, r.text
        versions = r.json()
        assert len(versions) >= 4
    finally:
        _delete_flavor(flavor)


def test_audit_log_records_each_mutation() -> None:
    flavor = _unique_flavor()
    try:
        body = {"block_on_uncertainty": False, "entries": []}
        requests.post(f"{API_URL}/v1/mcp-policies/{flavor}",
                      headers=_admin_headers(), json=body, timeout=5)
        body["block_on_uncertainty"] = True
        requests.put(f"{API_URL}/v1/mcp-policies/{flavor}",
                     headers=_admin_headers(), json=body, timeout=5)
        r = requests.get(f"{API_URL}/v1/mcp-policies/{flavor}/audit-log",
                         headers=_admin_headers(json_body=False), timeout=5)
        assert r.status_code == 200, r.text
        logs = r.json()
        types = {log["event_type"] for log in logs}
        assert "policy_created" in types
        assert "policy_updated" in types
    finally:
        _delete_flavor(flavor)


def test_diff_versions_surfaces_entries_added() -> None:
    flavor = _unique_flavor()
    try:
        body = {"block_on_uncertainty": False, "entries": []}
        requests.post(f"{API_URL}/v1/mcp-policies/{flavor}",
                      headers=_admin_headers(), json=body, timeout=5)
        body["entries"] = [{
            "server_url": "https://added.example.com",
            "server_name": "added",
            "entry_kind": "allow",
            "enforcement": "block",
        }]
        requests.put(f"{API_URL}/v1/mcp-policies/{flavor}",
                     headers=_admin_headers(), json=body, timeout=5)
        r = requests.get(
            f"{API_URL}/v1/mcp-policies/{flavor}/diff?from=1&to=2",
            headers=_admin_headers(json_body=False), timeout=5)
        assert r.status_code == 200, r.text
        diff = r.json()
        assert len(diff["entries_added"]) == 1
        assert diff["entries_added"][0]["server_name"] == "added"
    finally:
        _delete_flavor(flavor)


# ----- resolve precedence (D135) -----------------------------------


def test_resolve_returns_decision_path() -> None:
    flavor = _unique_flavor()
    try:
        body = {
            "block_on_uncertainty": False,
            "entries": [{
                "server_url": "https://resolved.example.com",
                "server_name": "resolved",
                "entry_kind": "deny",
                "enforcement": "block",
            }],
        }
        requests.post(f"{API_URL}/v1/mcp-policies/{flavor}",
                      headers=_admin_headers(), json=body, timeout=5)
        r = requests.get(
            f"{API_URL}/v1/mcp-policies/resolve",
            params={
                "flavor": flavor,
                "server_url": "https://resolved.example.com",
                "server_name": "resolved",
            },
            headers=_read_headers(), timeout=5)
        assert r.status_code == 200, r.text
        result = r.json()
        assert result["decision"] == "block"
        assert result["decision_path"] == "flavor_entry"
    finally:
        _delete_flavor(flavor)


# Step 6.7 A2 — resolve cascade contract (D135).
#
# The dashboard's MCPServerPolicyPill drives a `decision_path`-aware
# render: flavor_entry / global_entry returns explicit chroma; only
# mode_default falls through to the subdued "(default)" treatment.
# These tests lock the cascade so a future refactor of the resolver
# can't silently regress the precedence.


def test_resolve_falls_through_flavor_to_global_entry() -> None:
    """When the flavor's policy has NO matching entry but the global
    policy does, resolve must return decision_path=global_entry with
    the global entry's enforcement decision. Pre-D135 a buggy
    resolver could short-circuit on flavor with a missing-match → no
    fall-through; this test would catch that regression."""
    # The global policy is auto-created at API boot (D133) and is
    # initially empty. We mutate it for this test, then restore it
    # at teardown so other tests aren't affected.
    flavor = _unique_flavor()
    server_url = f"https://global-only-{uuid.uuid4().hex[:6]}.example.com"
    server_name = f"global-only-{uuid.uuid4().hex[:6]}"

    # Snapshot current global so we can restore in `finally`.
    global_get = requests.get(
        f"{API_URL}/v1/mcp-policies/global",
        headers=_read_headers(), timeout=5)
    assert global_get.status_code == 200
    saved_global = global_get.json()

    try:
        # Flavor policy exists but has NO entry for this server.
        flavor_body = {
            "block_on_uncertainty": False,
            "entries": [],
        }
        requests.post(f"{API_URL}/v1/mcp-policies/{flavor}",
                      headers=_admin_headers(), json=flavor_body, timeout=5)
        # Global policy gets the matching entry.
        global_body = {
            "mode": saved_global.get("mode", "blocklist"),
            "block_on_uncertainty": False,
            "entries": [{
                "server_url": server_url,
                "server_name": server_name,
                "entry_kind": "deny",
                "enforcement": "block",
            }],
        }
        requests.put(f"{API_URL}/v1/mcp-policies/global",
                     headers=_admin_headers(), json=global_body, timeout=5)

        r = requests.get(
            f"{API_URL}/v1/mcp-policies/resolve",
            params={
                "flavor": flavor,
                "server_url": server_url,
                "server_name": server_name,
            },
            headers=_read_headers(), timeout=5)
        assert r.status_code == 200, r.text
        result = r.json()
        assert result["decision_path"] == "global_entry", (
            f"expected fall-through to global_entry; got {result!r}"
        )
        assert result["decision"] == "block"
        assert result["scope"] == "global"
    finally:
        _delete_flavor(flavor)
        # Restore global to its pre-test state (empty entries by
        # default — boot auto-create starts empty).
        restore_body = {
            "mode": saved_global.get("mode", "blocklist"),
            "block_on_uncertainty": saved_global.get("block_on_uncertainty", False),
            "entries": saved_global.get("entries") or [],
        }
        requests.put(f"{API_URL}/v1/mcp-policies/global",
                     headers=_admin_headers(), json=restore_body, timeout=5)


def test_resolve_falls_through_to_mode_default() -> None:
    """When neither the flavor nor the global has a matching entry,
    resolve falls through to the global's mode default. Result
    semantics:
    - allowlist mode → block (nothing on the allow-list explicitly
      permits this server, so it's blocked).
    - blocklist mode → allow (nothing on the block-list explicitly
      denies this server, so it's allowed).

    Locks the "no explicit policy entry — using mode default"
    semantic the dashboard pill renders as "(default)"."""
    flavor = _unique_flavor()
    server_url = f"https://orphan-{uuid.uuid4().hex[:6]}.example.com"
    server_name = f"orphan-{uuid.uuid4().hex[:6]}"

    global_get = requests.get(
        f"{API_URL}/v1/mcp-policies/global",
        headers=_read_headers(), timeout=5)
    saved_global = global_get.json()

    try:
        # Flavor policy with no entries; global is unchanged (empty
        # entries from boot or restored from a previous test).
        requests.post(f"{API_URL}/v1/mcp-policies/{flavor}",
                      headers=_admin_headers(),
                      json={"block_on_uncertainty": False, "entries": []},
                      timeout=5)

        r = requests.get(
            f"{API_URL}/v1/mcp-policies/resolve",
            params={
                "flavor": flavor,
                "server_url": server_url,
                "server_name": server_name,
            },
            headers=_read_headers(), timeout=5)
        assert r.status_code == 200, r.text
        result = r.json()
        assert result["decision_path"] == "mode_default", (
            f"expected mode_default fallthrough; got {result!r}"
        )
        # The actual decision depends on the global mode at boot
        # time (default: blocklist → allow). Lock both arms via
        # explicit assertion against the global's mode.
        if saved_global.get("mode") == "allowlist":
            assert result["decision"] == "block"
        else:
            assert result["decision"] == "allow"
    finally:
        _delete_flavor(flavor)


# ----- power features ---------------------------------------------


def test_dry_run_returns_unresolvable_count() -> None:
    flavor = _unique_flavor()
    try:
        body = {"block_on_uncertainty": False, "entries": []}
        requests.post(f"{API_URL}/v1/mcp-policies/{flavor}",
                      headers=_admin_headers(), json=body, timeout=5)
        # Empty proposed policy + 1-hour window — engine returns
        # whatever traffic is in the dev DB; we just assert shape.
        r = requests.post(
            f"{API_URL}/v1/mcp-policies/{flavor}/dry_run?hours=1",
            headers=_admin_headers(), json=body, timeout=10)
        assert r.status_code == 200, r.text
        result = r.json()
        assert "events_replayed" in result
        assert "unresolvable_count" in result
        assert "per_server" in result
    finally:
        _delete_flavor(flavor)


def test_metrics_returns_empty_pre_step_4() -> None:
    flavor = _unique_flavor()
    try:
        body = {"block_on_uncertainty": False, "entries": []}
        requests.post(f"{API_URL}/v1/mcp-policies/{flavor}",
                      headers=_admin_headers(), json=body, timeout=5)
        r = requests.get(
            f"{API_URL}/v1/mcp-policies/{flavor}/metrics?period=24h",
            headers=_admin_headers(json_body=False), timeout=5)
        assert r.status_code == 200, r.text
        result = r.json()
        assert result["period"] == "24h"
        # Step 6.5 reshape: response now carries granularity +
        # zero-filled bucket array alongside the legacy
        # *_per_server aggregates. Empty events ⇒ empty
        # aggregates; the bucket array is zero-filled to the
        # 24-hour window at hour granularity, so each entry has
        # empty Blocks/Warns slices but the slot itself exists.
        assert result["granularity"] == "hour"
        assert isinstance(result["buckets"], list)
        assert len(result["buckets"]) > 0
        for bucket in result["buckets"]:
            assert "timestamp" in bucket
            assert bucket["blocks"] == []
            assert bucket["warns"] == []
        assert result["blocks_per_server"] == []
        assert result["warns_per_server"] == []
    finally:
        _delete_flavor(flavor)


def test_yaml_import_export_round_trip() -> None:
    flavor = _unique_flavor()
    try:
        body = {"block_on_uncertainty": False, "entries": []}
        requests.post(f"{API_URL}/v1/mcp-policies/{flavor}",
                      headers=_admin_headers(), json=body, timeout=5)
        yaml_body = (
            f"scope: flavor\n"
            f"scope_value: {flavor}\n"
            f"block_on_uncertainty: true\n"
            f"entries:\n"
            f"  - server_url: \"https://imported.example.com\"\n"
            f"    server_name: imported\n"
            f"    entry_kind: allow\n"
            f"    enforcement: block\n"
        )
        # Import requires application/yaml content-type
        headers = {
            "Authorization": f"Bearer {ADMIN_TOKEN}",
            "Content-Type": "application/yaml",
        }
        r = requests.post(
            f"{API_URL}/v1/mcp-policies/{flavor}/import",
            headers=headers, data=yaml_body, timeout=5)
        assert r.status_code == 200, r.text

        r = requests.get(
            f"{API_URL}/v1/mcp-policies/{flavor}/export",
            headers=_admin_headers(json_body=False), timeout=5)
        assert r.status_code == 200, r.text
        assert "server_name: imported" in r.text
    finally:
        _delete_flavor(flavor)


def test_templates_list_includes_three() -> None:
    r = requests.get(f"{API_URL}/v1/mcp-policies/templates",
                     headers=_read_headers(), timeout=5)
    assert r.status_code == 200, r.text
    templates = r.json()
    names = {t["name"] for t in templates}
    assert names == {"strict-baseline", "permissive-dev", "strict-with-common-allows"}


def test_apply_template_writes_audit_log_entry() -> None:
    flavor = _unique_flavor()
    try:
        body = {"block_on_uncertainty": False, "entries": []}
        requests.post(f"{API_URL}/v1/mcp-policies/{flavor}",
                      headers=_admin_headers(), json=body, timeout=5)
        r = requests.post(
            f"{API_URL}/v1/mcp-policies/{flavor}/apply_template",
            headers=_admin_headers(), json={"template": "strict-baseline"},
            timeout=5)
        assert r.status_code == 200, r.text
        r = requests.get(f"{API_URL}/v1/mcp-policies/{flavor}/audit-log",
                         headers=_admin_headers(json_body=False), timeout=5)
        logs = r.json()
        for log in logs:
            payload = log.get("payload", {})
            if payload.get("applied_template") == "strict-baseline":
                return
        raise AssertionError("audit log missing applied_template entry")
    finally:
        _delete_flavor(flavor)
