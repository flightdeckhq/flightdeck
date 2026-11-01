"""The edge proxy forwards /api and /ingest paths as sent.

The services accept their public prefix themselves, so a redirect a
service builds from the request (Swagger UI's, from the path as sent)
keeps the prefix and the client stays on that service. When the proxy
stripped the prefix, ``/api/docs/`` redirected to ``/docs/index.html``,
which is the dashboard.
"""

from __future__ import annotations

import urllib.request

import pytest

from tests.shared.fixtures import API_URL, INGESTION_URL


@pytest.mark.parametrize("base", [API_URL, INGESTION_URL])
@pytest.mark.parametrize("start", ["/docs", "/docs/"])
def test_swagger_ui_redirects_stay_under_the_prefix(base: str, start: str) -> None:
    with urllib.request.urlopen(base + start, timeout=10) as resp:
        final = resp.geturl()
        body = resp.read(4096).decode("utf-8", "replace")
    assert resp.status == 200
    assert final == base + "/docs/index.html", final
    assert "swagger" in body.lower(), body[:200]
