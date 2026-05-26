"""Discover active demo sessions and fire shutdown directives.

Identifies sessions in active state with flavor matching the demo set
(production + coding) and POSTs /v1/directives action=shutdown for
each. The directive rides back on the next sensor envelope; the
sensor raises DirectiveError on the next LLM call and the worker
flips the session state to closed.

For sessions that don't have a sensor receiving directives (e.g.
plugin-captured Claude Code parents — supports_directives=false),
the POST still records intent on the timeline but the state flip
relies on the session's natural Stop/SubagentStop emission.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

NetErr = (urllib.error.HTTPError, urllib.error.URLError)

API = "http://localhost:4000/api"
TOK = "tok_dev"
AUTH = {"Authorization": f"Bearer {TOK}", "Content-Type": "application/json"}


def _api(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers=AUTH)
    raw = urllib.request.urlopen(req, timeout=5).read()
    return json.loads(raw) if raw else None


PRODUCTION_FLAVORS = {
    "checkout-orchestrator", "research-assistant", "ingest-pipeline",
    "data-cleanup-worker", "weekly-digest", "support-triage",
    "cost-monitor", "mcp-explorer", "multi-step-research",
}

# Parent claude-code session_id (mine) — never killed. The plugin-
# captured Task sub-agents have flavor=claude-code AND
# parent_session_id pointing to me; they ARE targeted.
MY_PARENT_SESSION_ID = "fa5dc757-8c28-480b-850b-6863b552ad0c"


def main():
    try:
        resp = _api("GET", "/v1/sessions?limit=100")
    except NetErr as e:
        print(f"[killswitch] FAILED to list sessions: {e!r} — is the dev stack up?")
        sys.exit(1)
    sessions = (
        resp.get("sessions") or resp.get("data") or []
        if isinstance(resp, dict) else []
    )
    def is_target(s):
        if s.get("state") != "active":
            return False
        sid = s.get("session_id")
        if sid == MY_PARENT_SESSION_ID:
            return False  # never kill the orchestrator's own session
        flavor = s.get("flavor", "")
        if flavor in PRODUCTION_FLAVORS:
            return True
        # Plugin-captured Task sub-agents (flavor=claude-code with
        # parent_session_id pointing to me).
        if flavor == "claude-code" and s.get("parent_session_id"):
            return True
        return False

    targets = [s for s in sessions if is_target(s)]
    print(f"[killswitch] {len(targets)} target sessions / {len(sessions)} total fleet")
    ok = fail = 0
    for s in targets:
        sid = s["session_id"]
        flavor = s.get("flavor")
        body = {
            "action": "shutdown",
            "session_id": sid,
            "reason": "demo-killswitch",
            "grace_period_ms": 5000,
        }
        try:
            _api("POST", "/v1/directives", body)
            ok += 1
            print(f"  KILL {sid[:8]}  flavor={flavor}")
        except NetErr as e:
            fail += 1
            print(f"  FAIL {sid[:8]}  flavor={flavor}  err={e!r}")
    print(f"[killswitch] {ok} sent / {fail} failed")


if __name__ == "__main__":
    main()
