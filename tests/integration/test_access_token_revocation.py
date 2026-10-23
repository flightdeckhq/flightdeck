"""Revoking an access token takes effect at once on both services.

Both the ingestion API and the query API cache successful token
validations in memory. Deleting the token's ``access_tokens`` row fires
a Postgres NOTIFY that each service's listener turns into a cache
invalidation, so a revoked token is rejected on its very next request
rather than after the cache entry expires.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
import uuid

from .conftest import API_URL, INGESTION_URL, POLL_INTERVAL, auth_headers

# The revocation NOTIFY is delivered within milliseconds; this bound
# only absorbs a loaded CI host and stays far below the 60 s cache TTL
# the test proves is no longer the effective revocation delay.
REVOCATION_DEADLINE_SECS = 5.0


def _status(req: urllib.request.Request) -> int:
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return int(resp.status)
    except urllib.error.HTTPError as exc:
        return int(exc.code)


def _heartbeat(token: str) -> int:
    return _status(
        urllib.request.Request(
            f"{INGESTION_URL}/v1/heartbeat",
            data=json.dumps({"session_id": str(uuid.uuid4())}).encode(),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
    )


def _fleet(token: str) -> int:
    return _status(
        urllib.request.Request(
            f"{API_URL}/v1/fleet",
            headers={"Authorization": f"Bearer {token}"},
        )
    )


def _create_token(name: str) -> tuple[str, str]:
    req = urllib.request.Request(
        f"{API_URL}/v1/access-tokens",
        data=json.dumps({"name": name}).encode(),
        headers=auth_headers(json_body=True),
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=5) as resp:
        body = json.loads(resp.read())
    return body["id"], body["token"]


def _delete_token(token_id: str) -> int:
    return _status(
        urllib.request.Request(
            f"{API_URL}/v1/access-tokens/{token_id}",
            headers=auth_headers(),
            method="DELETE",
        )
    )


def test_revoked_token_is_rejected_immediately_on_both_services() -> None:
    token_id, token = _create_token(f"revocation-{uuid.uuid4().hex[:8]}")

    # Prime both services' validation caches with the live token.
    assert _heartbeat(token) == 200
    assert _fleet(token) == 200
    assert _heartbeat(token) == 200
    assert _fleet(token) == 200

    assert _delete_token(token_id) == 204

    # Poll briefly: delivery is asynchronous, but must not take anywhere
    # near the cache TTL.
    deadline = time.monotonic() + REVOCATION_DEADLINE_SECS
    while True:
        ingest, api = _heartbeat(token), _fleet(token)
        if ingest == 401 and api == 401:
            return
        assert time.monotonic() < deadline, (
            f"revoked token still accepted after {REVOCATION_DEADLINE_SECS}s: "
            f"ingestion={ingest} api={api}"
        )
        time.sleep(POLL_INTERVAL)
