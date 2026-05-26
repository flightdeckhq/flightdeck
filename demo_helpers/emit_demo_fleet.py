"""Emit a synthetic fleet of 7 sensor sessions, rich timelines, full event-type catalog.

POSTs synthesized event payloads directly to `POST /ingest/v1/events`.
Each session emits ~25-30 events of diverse types spread across 12-15s
of simulated time so the dashboard swimlane shows a packed,
real-agent-doing-work timeline.

Event types touched (from sensor/core/types.py EventType enum):
  session_start, session_end, pre_call, post_call, tool_call,
  policy_warn, policy_degrade, policy_block,
  policy_mcp_warn, policy_mcp_block,
  embeddings, llm_error, directive_result,
  mcp_tool_list, mcp_tool_call, mcp_resource_list, mcp_resource_read,
  mcp_prompt_list, mcp_prompt_get,
  mcp_server_attached, mcp_server_name_changed,
  subagent_start, subagent_stop.

Sessions:
  1. checkout-orchestrator      — Anthropic ecommerce, pre/post pairs + tools
  2. research-assistant         — OpenAI research, embeddings, policy_warn, llm_error
  3. mcp-explorer               — full MCP tour, server_attached, name_changed
  4. pii-redactor               — policy_mcp_warn → policy_mcp_block escalation
  5. support-triage             — token policy WARN → DEGRADE → BLOCK + directive_result
  6. multi-step-research        — parent w/ 3 sub-agent spawns, embeddings
  7. researcher-subagent        — child session, parent_session_id linked
"""
from __future__ import annotations

import datetime
import json
import time
import urllib.error
import urllib.request
import uuid

INGESTION = "http://localhost:4000/ingest"
TOKEN = "tok_dev"
SENSOR_VERSION = "0.4.0-demo"

# Global timing multiplier applied to every offset_s value via _now_iso.
# Bumping this stretches the apparent duration of every session in the
# fleet without rewriting per-event offsets.
SPACE_MULTIPLIER = 2.2


def _now_iso(offset_s: float = 0.0) -> str:
    t = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
        seconds=offset_s * SPACE_MULTIPLIER,
    )
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _post(payload: dict) -> int:
    """POST one event. Strips the private ``_offset_s`` field (only
    the dispatcher needs it) and stamps ``timestamp`` to wall-clock
    NOW so the worker logs the event at the moment it actually
    arrived rather than at a synthetic future time."""
    body = {k: v for k, v in payload.items() if not k.startswith("_")}
    body["timestamp"] = _now_iso()
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{INGESTION}/v1/events",
        data=data,
        method="POST",
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status
    except urllib.error.HTTPError as e:
        body_err = e.read().decode("utf-8", errors="replace")[:200]
        print(f"  HTTP {e.code} body={body_err}")
        return e.code
    except urllib.error.URLError as e:
        print(f"  URLError reason={e.reason!r} — is the dev stack up at {INGESTION}?")
        return 0


def _baseline(session_id, flavor, agent_name, agent_id, *,
              agent_type="coding", framework=None, model=None,
              parent_session_id=None):
    base = {
        "session_id": session_id,
        "agent_id": agent_id,
        "agent_type": agent_type,
        "client_type": "flightdeck_sensor",
        "agent_name": agent_name,
        "user": "demo",
        "hostname": "demo-host",
        "flavor": flavor,
        "host": "demo-host",
        "framework": framework,
        "model": model,
        "sensor_version": SENSOR_VERSION,
    }
    if parent_session_id:
        base["parent_session_id"] = parent_session_id
    return base


# ---- event-type builders --------------------------------------------------

def _ev(session_id, flavor, agent_name, agent_id, offset_s, event_type, **extra):
    """Generic event builder with common fields + any extra payload fields.

    ``timestamp`` is intentionally NOT set here — the dispatcher in
    ``main()`` stamps it at the moment of POST so the event lands at
    the worker with a wall-clock-current timestamp. ``_offset_s``
    (private, stripped before POST) drives the sleep-pacing between
    events so sessions transition active → closed at the dashboard's
    own pace instead of all collapsing to ``closed`` on the same
    burst tick.
    """
    p = _baseline(session_id, flavor, agent_name, agent_id, **{
        k: v for k, v in extra.items() if k in {"framework", "model", "parent_session_id"}
    })
    p["event_type"] = event_type
    p["_offset_s"] = offset_s
    for k, v in extra.items():
        if k not in {"framework", "model", "parent_session_id"}:
            p[k] = v
    return p


_VALID_CLOSE_REASONS = {
    "normal_exit", "directive_shutdown", "policy_block",
    "orphan_timeout", "sigkill_detected", "unknown",
}


def _policy_decision_block(flavor, decision, server_name=None):
    return {
        "policy_id": str(uuid.uuid4()),
        "scope": f"flavor:{flavor}",
        "decision": decision,
        "reason": f"{decision} threshold tripped",
        "decision_path": "flavor_entry",
        **({"matched_entry_label": server_name} if server_name else {}),
    }


# ---- session builders ----------------------------------------------------

class Sess:
    """Convenience handle so builders don't repeat shared args."""
    def __init__(self, sid, flavor, agent_name, agent_id, framework, model):
        self.sid = sid
        self.flavor = flavor
        self.agent_name = agent_name
        self.agent_id = agent_id
        self.framework = framework
        self.model = model

    def evt(self, offset_s, event_type, **extra):
        return _ev(self.sid, self.flavor, self.agent_name, self.agent_id,
                   offset_s, event_type, **extra)

    def start(self, offset_s=0.0, parent_session_id=None, context=None):
        e = self.evt(offset_s, "session_start",
                     framework=self.framework, model=self.model,
                     parent_session_id=parent_session_id)
        e["context"] = context or {
            "os": "Linux",
            "arch": "x86_64",
            "python_version": "3.12.7",
            "pid": 10000 + (hash(self.sid) % 50000),
            "process_name": f"python -m {self.flavor}",
            "working_dir": f"/srv/agents/{self.flavor}",
            "hostname": "demo-host",
            "user": "demo",
            "frameworks": [self.framework] if self.framework else [],
            "framework_version": "1.4.2",
            "supports_directives": True,
            "git_branch": "main",
            "git_repo": "agent-fleet",
            "git_commit": "abc1234",
        }
        return e

    def pre(self, offset_s, *, model=None):
        return self.evt(offset_s, "pre_call",
                        model=model or self.model)

    def post(self, offset_s, *, tokens_in, tokens_out, model=None, latency_ms=750):
        m = model or self.model
        return self.evt(offset_s, "post_call", model=m,
                        tokens_input=tokens_in, tokens_output=tokens_out,
                        tokens_total=tokens_in + tokens_out, latency_ms=latency_ms)

    def tool(self, offset_s, *, tool_name, latency_ms=110):
        return self.evt(offset_s, "tool_call",
                        tool_name=tool_name, latency_ms=latency_ms)

    def mcp(self, offset_s, event_type, server_name, *, tool_name=None,
            resource_uri=None, prompt_name=None, content_bytes=None,
            latency_ms=35):
        e = self.evt(offset_s, event_type,
                     server_url=f"stdio://python -m {server_name}",
                     server_name=server_name,
                     transport="stdio",
                     fingerprint=uuid.uuid4().hex[:16],
                     latency_ms=latency_ms)
        if tool_name:
            e["tool_name"] = tool_name
        if resource_uri:
            e["resource_uri"] = resource_uri
        if content_bytes is not None:
            e["content_bytes"] = content_bytes
        if prompt_name:
            e["prompt_name"] = prompt_name
        return e

    def mcp_attached(self, offset_s, server_name):
        e = self.mcp(offset_s, "mcp_server_attached", server_name)
        e["attached_at"] = _now_iso(offset_s)
        e["server_url_canonical"] = f"stdio://python -m {server_name}"
        return e

    def mcp_name_changed(self, offset_s, server_name, *, old_name):
        e = self.mcp(offset_s, "mcp_server_name_changed", server_name)
        e["old_server_name"] = old_name
        e["server_url_canonical"] = f"stdio://python -m {server_name}"
        return e

    def policy(self, offset_s, *, event_type, tokens_used, token_limit=200):
        decision = ({"policy_warn": "warn", "policy_degrade": "degrade",
                     "policy_block": "block"})[event_type]
        return self.evt(offset_s, event_type,
                        source="server",
                        tokens_used=tokens_used,
                        token_limit=token_limit,
                        reason=f"{event_type} at {tokens_used}/{token_limit}",
                        policy_decision=_policy_decision_block(
                            self.flavor, decision))

    def mcp_policy(self, offset_s, *, event_type, server_name, tool_name):
        decision = "warn" if event_type == "policy_mcp_warn" else "block"
        e = self.evt(offset_s, event_type,
                     server_url=f"stdio://python -m {server_name}",
                     server_name=server_name,
                     fingerprint=uuid.uuid4().hex[:16],
                     tool_name=tool_name,
                     transport="stdio",
                     policy_id=str(uuid.uuid4()),
                     scope=f"flavor:{self.flavor}",
                     decision_path="flavor_entry",
                     policy_decision=_policy_decision_block(
                         self.flavor, decision, server_name=server_name))
        return e

    def embed(self, offset_s, *, vectors=8, dimensions=1536, latency_ms=180,
              model="text-embedding-3-small"):
        return self.evt(offset_s, "embeddings",
                        model=model,
                        vector_count=vectors,
                        dimensions=dimensions,
                        latency_ms=latency_ms,
                        tokens_total=vectors * 24)

    def llm_error(self, offset_s, *, error_type, error_message, retried=False):
        return self.evt(offset_s, "llm_error",
                        model=self.model,
                        error_type=error_type,
                        error_message=error_message,
                        retried=retried,
                        latency_ms=240)

    def directive(self, offset_s, *, action, reason="control-plane directive"):
        return self.evt(offset_s, "directive_result",
                        action=action,
                        reason=reason,
                        directive_id=str(uuid.uuid4()))

    def subagent(self, offset_s, *, event_type, role, child_session_id=None):
        e = self.evt(offset_s, event_type, agent_role=role)
        if child_session_id:
            e["child_session_id"] = child_session_id
        return e

    def end(self, offset_s, reason="normal_exit"):
        if reason not in _VALID_CLOSE_REASONS:
            raise ValueError(f"invalid close_reason {reason!r}")
        return self.evt(offset_s, "session_end", close_reason=reason)


# Deterministic agent_id per flavor so the historical seed and the
# live-burst hit the SAME agent row in the fleet (otherwise each run
# creates a new agent_id and the 7-day sparkline shows nothing for
# "today's" agent). UUID5 over a stable namespace + the flavor name
# keeps this hermetic.
_AGENT_ID_NAMESPACE = uuid.UUID("f1d0a7e0-d3a0-4d3c-9c7c-c0ffeec0ffee")


def demo_agent_id(flavor: str) -> str:
    return str(uuid.uuid5(_AGENT_ID_NAMESPACE, f"demo-fleet:{flavor}"))


def _new(flavor, agent_name_suffix, framework, model):
    return Sess(
        sid=str(uuid.uuid4()),
        flavor=flavor,
        agent_name=f"{flavor}-1",
        agent_id=demo_agent_id(flavor),
        framework=framework,
        model=model,
    )


def build_checkout_orchestrator():
    s = _new("checkout-orchestrator", "1", "anthropic", "claude-haiku-4-5-20251001")
    mcp = "payment-gateway-mcp"
    ctx = {
        "os": "Linux", "arch": "x86_64", "python_version": "3.12.7",
        "pid": 18432, "process_name": "python -m checkout.orchestrator",
        "working_dir": "/srv/agents/checkout-orchestrator",
        "hostname": "ord-checkout-7a3f", "user": "agent",
        "frameworks": ["anthropic"], "framework_version": "anthropic==0.40.0",
        "supports_directives": True,
        "git_branch": "main", "git_repo": "checkout-service",
        "git_commit": "a3f4b2c",
        "container_image": "checkout-orchestrator:1.4.2",
        "region": "us-east-1",
    }
    events = [
        s.start(0.0, context=ctx),
        s.mcp_attached(0.4, mcp),
        s.pre(0.9),      s.post(1.6, tokens_in=72, tokens_out=28),
        s.tool(2.3, tool_name="validate_cart"),
        s.pre(3.0),      s.post(3.7, tokens_in=120, tokens_out=42),
        s.tool(4.4, tool_name="check_inventory"),
        s.mcp(5.1, "mcp_tool_list", mcp),
        s.pre(5.7),      s.post(6.4, tokens_in=160, tokens_out=55, latency_ms=920),
        s.tool(7.1, tool_name="apply_discount_code"),
        s.mcp(7.8, "mcp_tool_call", mcp, tool_name="verify_billing_address"),
        s.pre(8.5),      s.post(9.3, tokens_in=210, tokens_out=70, latency_ms=1100),
        s.tool(10.0, tool_name="check_shipping_zones"),
        s.policy(10.5, event_type="policy_warn", tokens_used=152),
        s.mcp(11.0, "mcp_tool_call", mcp, tool_name="charge_card", latency_ms=380),
        s.directive(11.6, action="warn",
                    reason="cumulative tokens crossed warn threshold"),
        s.pre(12.2),     s.post(12.9, tokens_in=180, tokens_out=58),
        s.tool(13.6, tool_name="create_order"),
        s.mcp(14.2, "mcp_resource_read", mcp, resource_uri="cfg://merchant-settings",
              content_bytes=312),
        s.pre(14.8),     s.post(15.5, tokens_in=140, tokens_out=44),
        s.tool(16.1, tool_name="send_confirmation_email"),
        s.tool(16.7, tool_name="enqueue_fulfillment"),
        s.pre(17.3),     s.post(17.9, tokens_in=95, tokens_out=22),
        s.end(18.5),
    ]
    return s.sid, events


def build_research_assistant():
    s = _new("research-assistant", "1", "openai", "gpt-4o-mini")
    mcp = "web-search-mcp"
    ctx = {
        "os": "Darwin", "arch": "arm64", "python_version": "3.11.9",
        "pid": 7321, "process_name": "python -m research.assistant",
        "working_dir": "/Users/researcher/agents/research-assistant",
        "hostname": "mac-researcher-1", "user": "researcher",
        "frameworks": ["openai"], "framework_version": "openai==1.45.0",
        "supports_directives": True,
        "git_branch": "feat/expand-citations",
        "git_repo": "research-tools", "git_commit": "9e1d40a",
        "region": "local",
    }
    events = [
        s.start(0.0, context=ctx),
        s.mcp_attached(0.5, mcp),
        s.pre(1.0),      s.post(1.7, tokens_in=140, tokens_out=45),
        s.tool(2.3, tool_name="web_search"),
        s.mcp(2.9, "mcp_tool_call", mcp, tool_name="fetch_page"),
        s.embed(3.5, vectors=12, dimensions=1536),
        s.pre(4.1),      s.post(4.8, tokens_in=220, tokens_out=78),
        s.tool(5.5, tool_name="extract_main_text"),
        s.mcp(6.1, "mcp_resource_list", mcp),
        s.mcp(6.7, "mcp_resource_read", mcp, resource_uri="cache://recent-articles",
              content_bytes=2840),
        s.embed(7.3, vectors=18),
        s.pre(7.9),      s.post(8.7, tokens_in=310, tokens_out=92, latency_ms=1350),
        s.tool(9.4, tool_name="fetch_url"),
        s.llm_error(10.0, error_type="RateLimitError",
                    error_message="429 too many requests; retry-after=5", retried=True),
        s.directive(10.6, action="degrade",
                    reason="provider rate limit; switching to cheaper model"),
        s.pre(11.2),     s.post(12.0, tokens_in=265, tokens_out=88,
                                model="gpt-4o-mini-batch"),
        s.policy(12.1, event_type="policy_warn", tokens_used=178),
        s.tool(12.8, tool_name="rerank_results"),
        s.mcp(13.4, "mcp_prompt_get", mcp, prompt_name="summarize-citations"),
        s.embed(14.0, vectors=24),
        s.pre(14.7),     s.post(15.4, tokens_in=180, tokens_out=110, latency_ms=1500),
        s.tool(16.1, tool_name="cite_sources"),
        s.pre(16.8),     s.post(17.5, tokens_in=120, tokens_out=72),
        s.end(18.1),
    ]
    return s.sid, events


def build_mcp_explorer():
    s = _new("mcp-explorer", "1", "mcp", "claude-haiku-4-5-20251001")
    srv = "flightdeck-mcp-reference"
    srv2 = "flightdeck-mcp-secondary"
    ctx = {
        "os": "Linux", "arch": "aarch64", "python_version": "3.13.1",
        "pid": 22118, "process_name": "python -m mcp.explorer",
        "working_dir": "/opt/agents/mcp-explorer",
        "hostname": "k8s-mcp-explorer-5d9", "user": "agent",
        "frameworks": ["mcp"], "framework_version": "mcp==1.6.0",
        "supports_directives": True,
        "git_branch": "main", "git_repo": "mcp-explorer",
        "git_commit": "44c7e21",
        "container_image": "mcp-explorer:0.9.3",
        "region": "eu-west-1", "k8s_pod": "mcp-explorer-5d9-xqt2v",
    }
    events = [
        s.start(0.0, context=ctx),
        s.mcp_attached(0.5, srv),
        s.pre(1.0),      s.post(1.7, tokens_in=85, tokens_out=30),
        s.mcp(2.3, "mcp_tool_list", srv),
        s.pre(2.9),      s.post(3.5, tokens_in=110, tokens_out=40),
        s.mcp(4.1, "mcp_tool_call", srv, tool_name="echo"),
        s.mcp(4.7, "mcp_tool_call", srv, tool_name="add"),
        s.pre(5.3),      s.post(6.0, tokens_in=98, tokens_out=35),
        s.mcp(6.6, "mcp_tool_call", srv, tool_name="slow_echo", latency_ms=240),
        s.mcp(7.2, "mcp_resource_list", srv),
        s.mcp(7.8, "mcp_resource_read", srv, resource_uri="mem://demo", content_bytes=47),
        s.policy(8.3, event_type="policy_warn", tokens_used=132),
        s.pre(8.9),      s.post(9.6, tokens_in=140, tokens_out=55),
        s.mcp_attached(10.2, srv2),
        s.mcp_name_changed(10.8, srv2, old_name="flightdeck-mcp-helper"),
        s.mcp(11.4, "mcp_tool_list", srv2),
        s.mcp(12.0, "mcp_tool_call", srv2, tool_name="reverse"),
        s.directive(12.5, action="warn",
                    reason="dual-server scan in progress; verify policy coverage"),
        s.mcp(13.0, "mcp_prompt_list", srv),
        s.mcp(13.6, "mcp_prompt_get", srv, prompt_name="greet"),
        s.pre(14.2),     s.post(15.0, tokens_in=165, tokens_out=70),
        s.tool(15.6, tool_name="synthesize_findings"),
        s.pre(16.2),     s.post(16.9, tokens_in=90, tokens_out=32),
        s.end(17.6),
    ]
    return s.sid, events


def build_pii_redactor():
    s = _new("pii-redactor", "1", "mcp", "claude-haiku-4-5-20251001")
    allowed = "flightdeck-mcp-reference"
    forbidden = "flightdeck-mcp-secondary"
    ctx = {
        "os": "Linux", "arch": "x86_64", "python_version": "3.11.8",
        "pid": 30412, "process_name": "python -m compliance.pii_redactor",
        "working_dir": "/srv/compliance/pii-redactor",
        "hostname": "compliance-pii-2a", "user": "compliance-svc",
        "frameworks": ["mcp"], "framework_version": "mcp==1.5.4",
        "supports_directives": True,
        "git_branch": "main", "git_repo": "compliance-agents",
        "git_commit": "b71f019",
        "container_image": "compliance/pii-redactor:2.1.0",
        "region": "eu-central-1",
        "compliance_zone": "gdpr-strict",
    }
    events = [
        s.start(0.0, context=ctx),
        s.mcp_attached(0.5, allowed),
        s.pre(1.0),      s.post(1.7, tokens_in=120, tokens_out=38),
        s.mcp(2.3, "mcp_tool_list", allowed),
        s.mcp(2.9, "mcp_tool_call", allowed, tool_name="echo"),
        s.pre(3.5),      s.post(4.2, tokens_in=140, tokens_out=45),
        s.mcp_attached(4.8, forbidden),
        s.mcp(5.3, "mcp_tool_list", forbidden),
        s.mcp_policy(5.9, event_type="policy_mcp_warn",
                     server_name=forbidden, tool_name="reverse"),
        s.pre(6.5),      s.post(7.2, tokens_in=180, tokens_out=55),
        s.policy(7.3, event_type="policy_warn", tokens_used=158),
        s.mcp_policy(8.0, event_type="policy_mcp_block",
                     server_name=forbidden, tool_name="reverse"),
        s.directive(8.6, action="warn",
                    reason="forbidden MCP server activity detected"),
        s.tool(9.2, tool_name="handle_block_error"),
        s.pre(9.8),      s.post(10.5, tokens_in=200, tokens_out=60),
        s.mcp_policy(11.1, event_type="policy_mcp_block",
                     server_name=forbidden, tool_name="redact_pii"),
        s.tool(11.7, tool_name="report_compliance_event"),
        s.pre(12.3),     s.post(13.0, tokens_in=95, tokens_out=30),
        s.directive(13.6, action="shutdown",
                    reason="repeated policy_mcp_block; control plane initiated shutdown"),
        s.end(14.2, reason="policy_block"),
    ]
    return s.sid, events


def build_support_triage():
    s = _new("support-triage", "1", "crewai", "gpt-4o")
    kb = "kb-search-mcp"
    ctx = {
        "os": "Linux", "arch": "x86_64", "python_version": "3.12.5",
        "pid": 41733, "process_name": "python -m support.triage",
        "working_dir": "/srv/agents/support-triage",
        "hostname": "support-triage-9k", "user": "agent",
        "frameworks": ["crewai", "langchain"],
        "framework_version": "crewai==1.2.4",
        "supports_directives": True,
        "git_branch": "main", "git_repo": "support-bot",
        "git_commit": "f3a8c1d",
        "container_image": "support/triage:1.7.0",
        "region": "us-west-2",
    }
    events = [
        s.start(0.0, context=ctx),
        s.mcp_attached(0.5, kb),
        s.pre(1.0),      s.post(1.7, tokens_in=145, tokens_out=55),
        s.tool(2.3, tool_name="classify_intent"),
        s.pre(2.9),      s.post(3.6, tokens_in=165, tokens_out=62),
        s.policy(3.7, event_type="policy_warn", tokens_used=212),
        s.tool(4.3, tool_name="search_kb"),
        s.mcp(4.9, "mcp_tool_call", kb, tool_name="lookup_article"),
        s.embed(5.5, vectors=8),
        s.pre(6.1),      s.post(6.8, tokens_in=190, tokens_out=72),
        s.tool(7.4, tool_name="rerank_kb_results"),
        s.mcp(8.0, "mcp_resource_read", kb, resource_uri="kb://customer-history",
              content_bytes=1280),
        s.pre(8.6),      s.post(9.3, tokens_in=210, tokens_out=68, latency_ms=1200),
        s.policy(9.4, event_type="policy_degrade", tokens_used=445),
        s.directive(10.0, action="degrade", reason="token budget exceeded 30%"),
        s.tool(10.6, tool_name="draft_response"),
        s.pre(11.2),     s.post(11.9, tokens_in=160, tokens_out=58),
        s.tool(12.5, tool_name="check_sentiment"),
        s.pre(13.1),     s.post(13.8, tokens_in=140, tokens_out=42),
        s.policy(13.9, event_type="policy_block", tokens_used=607),
        s.directive(14.5, action="shutdown", reason="token budget exceeded 70%"),
        s.end(15.1, reason="policy_block"),
    ]
    return s.sid, events


def build_multi_step_research(child_sid):
    s = _new("multi-step-research", "1", "langgraph", "claude-haiku-4-5-20251001")
    mcp = "arxiv-search-mcp"
    child2 = str(uuid.uuid4())
    child3 = str(uuid.uuid4())
    ctx = {
        "os": "Linux", "arch": "x86_64", "python_version": "3.12.7",
        "pid": 51280, "process_name": "python -m research.multi_step",
        "working_dir": "/srv/agents/multi-step-research",
        "hostname": "research-multi-step-3b", "user": "agent",
        "frameworks": ["langgraph", "langchain"],
        "framework_version": "langgraph==0.2.50",
        "supports_directives": True,
        "git_branch": "main", "git_repo": "research-agents",
        "git_commit": "2e8c3f9",
        "container_image": "research/multi-step:1.3.5",
        "region": "us-east-1",
        "gpu_type": "A10G",
    }
    events = [
        s.start(0.0, context=ctx),
        s.mcp_attached(0.5, mcp),
        s.pre(1.0),      s.post(1.7, tokens_in=180, tokens_out=70),
        s.tool(2.3, tool_name="plan_research"),
        s.embed(2.9, vectors=10),
        s.mcp(3.4, "mcp_tool_call", mcp, tool_name="arxiv_search"),
        s.subagent(4.0, event_type="subagent_start", role="researcher",
                   child_session_id=child_sid),
        s.pre(4.6),      s.post(5.3, tokens_in=145, tokens_out=52),
        s.subagent(6.0, event_type="subagent_stop", role="researcher",
                   child_session_id=child_sid),
        s.tool(6.6, tool_name="consolidate_findings"),
        s.policy(7.2, event_type="policy_warn", tokens_used=148),
        s.subagent(7.8, event_type="subagent_start", role="writer",
                   child_session_id=child2),
        s.pre(8.4),      s.post(9.1, tokens_in=210, tokens_out=85),
        s.directive(9.7, action="warn",
                    reason="parent + child token budget approaching threshold"),
        s.subagent(10.3, event_type="subagent_stop", role="writer",
                   child_session_id=child2),
        s.tool(10.9, tool_name="format_draft"),
        s.embed(11.5, vectors=14),
        s.mcp(12.0, "mcp_resource_read", mcp, resource_uri="arxiv://2401.00001",
              content_bytes=4500),
        s.subagent(12.6, event_type="subagent_start", role="reviewer",
                   child_session_id=child3),
        s.pre(13.2),     s.post(13.9, tokens_in=185, tokens_out=65),
        s.subagent(14.5, event_type="subagent_stop", role="reviewer",
                   child_session_id=child3),
        s.tool(15.1, tool_name="finalize_report"),
        s.pre(15.7),     s.post(16.4, tokens_in=240, tokens_out=92, latency_ms=1450),
        s.end(17.0),
    ]
    return s.sid, events


def build_researcher_subagent(parent_sid, child_sid):
    s = Sess(sid=child_sid, flavor="researcher-subagent",
             agent_name="researcher-subagent-1",
             agent_id=demo_agent_id("researcher-subagent"),
             framework="langgraph",
             model="claude-haiku-4-5-20251001")
    mcp = "arxiv-search-mcp"
    ctx = {
        "os": "Linux", "arch": "x86_64", "python_version": "3.12.7",
        "pid": 51281, "process_name": "python -m research.subagent",
        "working_dir": "/srv/agents/multi-step-research",
        "hostname": "research-multi-step-3b", "user": "agent",
        "frameworks": ["langgraph"],
        "framework_version": "langgraph==0.2.50",
        "supports_directives": True,
        "git_branch": "main", "git_repo": "research-agents",
        "git_commit": "2e8c3f9",
        "container_image": "research/multi-step:1.3.5",
        "region": "us-east-1",
        "parent_role": "multi-step-research",
    }
    events = [
        s.start(4.0, parent_session_id=parent_sid, context=ctx),
        s.mcp_attached(4.4, mcp),
        s.pre(4.8),      s.post(5.3, tokens_in=110, tokens_out=38),
        s.tool(5.7, tool_name="search_papers"),
        s.mcp(6.0, "mcp_tool_call", mcp, tool_name="arxiv_search"),
        s.embed(6.4, vectors=6),
        s.pre(6.8),      s.post(7.2, tokens_in=170, tokens_out=55),
        s.tool(7.6, tool_name="read_paper"),
        s.mcp(7.9, "mcp_resource_read", mcp, resource_uri="arxiv://2401.00001",
              content_bytes=4500),
        s.policy(8.2, event_type="policy_warn", tokens_used=140),
        s.pre(8.5),      s.post(8.9, tokens_in=145, tokens_out=48),
        s.tool(9.2, tool_name="extract_quotes"),
        s.embed(9.5, vectors=8),
        s.directive(9.8, action="warn",
                    reason="child token budget at warn threshold"),
        s.end(10.1),
    ]
    return s.sid, events


def main():
    """Build all 7 sessions, flatten into one stream sorted by
    ``_offset_s``, then dispatch with real-time pacing so events
    arrive at the worker over ``max_offset * SPACE_MULTIPLIER``
    seconds of wall clock — sessions stay ``active`` until their
    ``session_end`` actually dispatches at the end of their arc,
    instead of all flipping to ``closed`` on the same instantaneous
    burst tick. Events from different sessions interleave in
    chronological order so the dashboard timeline tells a coherent
    cross-fleet story rather than a flood of session_starts
    followed by a flood of session_ends.
    """
    print("[emit_demo_fleet] building 7 rich synthetic sensor sessions")

    child_sid = str(uuid.uuid4())
    parent_sid, parent_events = build_multi_step_research(child_sid)
    _, child_events = build_researcher_subagent(parent_sid, child_sid)

    builds = [
        ("checkout-orchestrator", *build_checkout_orchestrator()),
        ("research-assistant", *build_research_assistant()),
        ("mcp-explorer", *build_mcp_explorer()),
        ("pii-redactor", *build_pii_redactor()),
        ("support-triage", *build_support_triage()),
        ("multi-step-research (parent)", parent_sid, parent_events),
        ("researcher-subagent (child)", child_sid, child_events),
    ]
    # Flatten + sort by offset across all sessions.
    flat: list[dict] = []
    for label, _sid, events in builds:
        print(f"  {label}: {len(events)} events")
        flat.extend(events)
    flat.sort(key=lambda e: e["_offset_s"])
    if not flat:
        print("[emit_demo_fleet] no events to dispatch")
        return

    max_offset = max(e["_offset_s"] for e in flat)
    burst_s = max_offset * SPACE_MULTIPLIER
    print(
        f"\n[emit_demo_fleet] dispatching {len(flat)} events over ~{burst_s:.1f}s "
        f"of wall clock (SPACE_MULTIPLIER={SPACE_MULTIPLIER}, max offset={max_offset:.1f}s)"
    )

    t0 = time.monotonic()
    ok = 0
    rejected = 0
    for e in flat:
        target_wall = t0 + e["_offset_s"] * SPACE_MULTIPLIER
        sleep_for = target_wall - time.monotonic()
        if sleep_for > 0:
            time.sleep(sleep_for)
        rc = _post(e)
        if rc == 200:
            ok += 1
        else:
            rejected += 1

    elapsed = time.monotonic() - t0
    print(
        f"\n[emit_demo_fleet] complete in {elapsed:.2f}s — "
        f"{ok}/{len(flat)} accepted ({rejected} rejected)"
    )


if __name__ == "__main__":
    main()
