"""Seed 7 days of synthetic historical events for the demo fleet so
the Agents-page sparklines (Tokens / Latency p95 / Errors) render
naturally with ~7-8 data points before the live burst layers
"today's" activity on top.

Strategy:
  1. For each demo flavor, generate D days of "yesterday-and-back"
     sessions — one session per day with a small batch of post_call
     events (varied tokens + latency), a handful of tool_call
     events, and an occasional llm_error to put pixels in the
     errors sparkline.
  2. POST every event through the normal ingestion API so the
     worker materialises sessions, agents, and rollups without us
     having to hand-roll the FK chain.
  3. Once the worker has fully drained, UPDATE
     events.occurred_at + sessions.{started_at,last_seen_at,ended_at}
     via ``docker exec psql`` to backdate the rows to their target
     days. ingestion rejects > 24h-past timestamps at the wire
     boundary; backdating via SQL after-the-fact is the same
     pattern tests/e2e-fixtures/seed.py uses.
  4. Bonus: also backdate the agents.first_seen_at so the agent
     summary period window covers all the seeded days.

Per-flavor agent_id matches ``emit_demo_fleet.demo_agent_id(flavor)``
so the live burst lands on the same fleet row.
"""
from __future__ import annotations

import datetime
import json
import random
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path("/tmp/demo_helpers")))
from emit_demo_fleet import demo_agent_id  # noqa: E402

INGESTION = "http://localhost:4000/ingest"
API = "http://localhost:4000/api"
TOKEN = "tok_dev"
SENSOR_VERSION = "0.4.0-demo"
POSTGRES_CONTAINER = "docker-postgres-1"

# D115 agent_id derivation — matches the plugin's
# ``deriveAgentId`` (plugin/hooks/scripts/agent_id.mjs) so the
# historical seed lands on the SAME fleet row the live plugin
# emits when ``omria@Omri-PC`` / ``omria@Omri-PC/general-purpose``
# / etc spawn during the recording. The namespace literal is the
# frozen D115 constant.
PLUGIN_AGENT_ID_NAMESPACE = uuid.UUID("ee22ab58-26fc-54ef-91b4-b5c0a97f9b61")


def derive_plugin_agent_id(*, agent_type: str, user: str, hostname: str,
                            client_type: str, agent_name: str,
                            agent_role: str | None = None) -> str:
    """Re-implementation of the D115 5- or 6-tuple agent_id derivation
    (see plugin/hooks/scripts/agent_id.mjs::deriveAgentId)."""
    path = (
        f"flightdeck://{agent_type}/{user}@{hostname}"
        f"/{client_type}/{agent_name}"
    )
    if agent_role is not None and agent_role.strip():
        path = f"{path}/{agent_role.strip()}"
    return str(uuid.uuid5(PLUGIN_AGENT_ID_NAMESPACE, path))

# Days of history to seed. Each day gets one session + events for
# every demo flavor. The Agents page default period is 7d/day-bucket
# so 7 buckets cover the column-axis nicely; we add a marker on
# day 0 too so the live burst lands as the rightmost bucket.
DAYS_BACK = (7, 6, 5, 4, 3, 2, 1)

# Per-flavor traffic profile. Drives how many events per session
# and the LLM model in use so the sparkline shapes look distinct.
FLAVOR_PROFILES = {
    "checkout-orchestrator": {
        "framework": "anthropic", "model": "claude-haiku-4-5-20251001",
        "agent_type": "production", "client_type": "flightdeck_sensor",
        "agent_name_suffix": "1",
        "events_per_day": (8, 14),   # post_call count per session
        "tools_per_day": (4, 7),
        "tokens_in_range": (60, 250),
        "tokens_out_range": (20, 80),
        "latency_range": (320, 1200),
        "errors_per_day": (0, 2),
        "tool_names": ["validate_cart", "check_inventory",
                       "apply_discount_code", "calculate_tax",
                       "create_order", "send_confirmation_email"],
    },
    "research-assistant": {
        "framework": "openai", "model": "gpt-4o-mini",
        "agent_type": "production", "client_type": "flightdeck_sensor",
        "agent_name_suffix": "1",
        "events_per_day": (10, 18),
        "tools_per_day": (4, 8),
        "tokens_in_range": (120, 340),
        "tokens_out_range": (40, 130),
        "latency_range": (520, 1850),
        "errors_per_day": (2, 5),     # rate-limit-prone integrator
        "tool_names": ["web_search", "fetch_url", "rerank_results",
                       "cite_sources", "extract_main_text"],
    },
    "mcp-explorer": {
        "framework": "mcp", "model": "claude-haiku-4-5-20251001",
        "agent_type": "production", "client_type": "flightdeck_sensor",
        "agent_name_suffix": "1",
        "events_per_day": (6, 12),
        "tools_per_day": (1, 3),
        "tokens_in_range": (70, 180),
        "tokens_out_range": (20, 70),
        "latency_range": (260, 740),
        "errors_per_day": (0, 1),
        "tool_names": ["synthesize_findings"],
    },
    "pii-redactor": {
        "framework": "mcp", "model": "claude-haiku-4-5-20251001",
        "agent_type": "production", "client_type": "flightdeck_sensor",
        "agent_name_suffix": "1",
        "events_per_day": (5, 9),
        "tools_per_day": (3, 6),
        "tokens_in_range": (100, 240),
        "tokens_out_range": (25, 70),
        "latency_range": (380, 1050),
        "errors_per_day": (1, 3),     # policy_mcp_block backpressure
        "tool_names": ["handle_block_error", "report_compliance_event"],
    },
    "support-triage": {
        "framework": "crewai", "model": "gpt-4o",
        "agent_type": "production", "client_type": "flightdeck_sensor",
        "agent_name_suffix": "1",
        "events_per_day": (9, 16),
        "tools_per_day": (5, 9),
        "tokens_in_range": (130, 290),
        "tokens_out_range": (40, 110),
        "latency_range": (640, 1900),
        "errors_per_day": (2, 4),     # token-policy degrade ladder
        "tool_names": ["classify_intent", "search_kb", "rerank_kb_results",
                       "draft_response", "check_sentiment"],
    },
    "multi-step-research": {
        "framework": "langgraph", "model": "claude-haiku-4-5-20251001",
        "agent_type": "production", "client_type": "flightdeck_sensor",
        "agent_name_suffix": "1",
        "events_per_day": (8, 13),
        "tools_per_day": (4, 7),
        "tokens_in_range": (160, 320),
        "tokens_out_range": (55, 130),
        "latency_range": (700, 1750),
        "errors_per_day": (1, 3),
        "tool_names": ["plan_research", "consolidate_findings",
                       "format_draft", "finalize_report"],
    },
    "researcher-subagent": {
        "framework": "langgraph", "model": "claude-haiku-4-5-20251001",
        "agent_type": "production", "client_type": "flightdeck_sensor",
        "agent_name_suffix": "1",
        "events_per_day": (4, 8),
        "tools_per_day": (2, 4),
        "tokens_in_range": (90, 200),
        "tokens_out_range": (30, 80),
        "latency_range": (420, 1180),
        "errors_per_day": (0, 2),
        "tool_names": ["search_papers", "read_paper", "extract_quotes"],
    },
}

# Claude Code (plugin-side) agents. These share an agent_type
# ("coding") + client_type ("claude_code") that the dashboard
# colour-codes distinctly from sensor-instrumented production
# agents, and they hit the cost-cell em-dash gate (Flightdeck
# has no pricing for Claude Code agents — see AgentTableRow).
# Token volumes here are 100× the sensor flavors because Claude
# Code's hot-path call carries the user's full conversation +
# system prompt; an idle "investigate the codebase" run easily
# burns 200k context tokens per turn.
_CLAUDE_CODE_HOST = "Omri-PC"
_CLAUDE_CODE_USER = "omria"
_CLAUDE_CODE_AGENT_NAME = f"{_CLAUDE_CODE_USER}@{_CLAUDE_CODE_HOST}"


def _claude_code_profile(*, agent_role: str | None,
                          flavor_label: str,
                          events_per_day: tuple[int, int],
                          tools_per_day: tuple[int, int],
                          errors_per_day: tuple[int, int],
                          tool_names: list[str]) -> dict:  # noqa: PLR0913
    """Per-claude-code-agent profile factory. The agent_id resolves
    via the D115 plugin grammar so the historical seed lines up
    with the live ``omria@Omri-PC[/<role>]`` rows the plugin
    emits during the recording."""
    return {
        "framework": "claude-code",
        "model": "claude-opus-4-7",
        "agent_type": "coding",
        "client_type": "claude_code",
        "agent_name_suffix": "claude-code",
        "events_per_day": events_per_day,
        "tools_per_day": tools_per_day,
        "tokens_in_range": (80_000, 200_000),
        "tokens_out_range": (120, 1_400),
        "latency_range": (2_400, 11_000),
        "errors_per_day": errors_per_day,
        "tool_names": tool_names,
        # Plugin-matching agent_id derivation. Closes over the role
        # so the same factory builds 4 distinct claude-code agents
        # (root + general-purpose + Explore + Plan).
        "agent_id_fn": (lambda role=agent_role: derive_plugin_agent_id(
            agent_type="coding",
            user=_CLAUDE_CODE_USER,
            hostname=_CLAUDE_CODE_HOST,
            client_type="claude_code",
            agent_name=_CLAUDE_CODE_AGENT_NAME,
            agent_role=role,
        )),
        # Fleet view groups claude-code agents under
        # ``omria@Omri-PC[/<role>]`` agent_name — the seed override
        # below replaces ``_base()``'s default
        # ``agent_name = f"{flavor}-{suffix}"`` with this exact
        # string so the row lines up with the live plugin's row.
        "agent_name_override": (
            f"{_CLAUDE_CODE_AGENT_NAME}/{agent_role}"
            if agent_role else _CLAUDE_CODE_AGENT_NAME
        ),
        "flavor_label": flavor_label,
        "agent_role": agent_role,
    }


# Note these flavor keys are used internally for routing only;
# the on-wire ``flavor`` lands as ``claude-code`` for every
# Claude Code session (matches the plugin's session_start
# emission).
FLAVOR_PROFILES.update({
    "claude-code-root": _claude_code_profile(
        agent_role=None,
        flavor_label="claude-code",
        events_per_day=(6, 12),
        tools_per_day=(8, 18),
        errors_per_day=(0, 2),
        tool_names=["Bash", "Read", "Edit", "Grep", "Glob",
                    "Write", "TodoWrite"],
    ),
    "claude-code-general-purpose": _claude_code_profile(
        agent_role="general-purpose",
        flavor_label="claude-code",
        events_per_day=(4, 8),
        tools_per_day=(5, 12),
        errors_per_day=(0, 1),
        tool_names=["Bash", "Read", "Grep", "Glob", "Edit"],
    ),
    "claude-code-Explore": _claude_code_profile(
        agent_role="Explore",
        flavor_label="claude-code",
        events_per_day=(4, 8),
        tools_per_day=(6, 14),
        errors_per_day=(0, 1),
        tool_names=["Glob", "Grep", "Read", "Bash"],
    ),
    "claude-code-Plan": _claude_code_profile(
        agent_role="Plan",
        flavor_label="claude-code",
        events_per_day=(3, 6),
        tools_per_day=(5, 10),
        errors_per_day=(0, 1),
        tool_names=["Read", "Grep", "Bash", "Glob"],
    ),
})

# llm_error sub-types we round-robin across so the Errors sparkline
# isn't just "one error type repeated." Reads like real-world wire
# noise: provider rate limits, upstream timeouts, structured-output
# parse failures, transient 5xxs.
_ERROR_TYPES = [
    "RateLimitError",
    "APITimeoutError",
    "ServiceUnavailableError",
    "OutputParserException",
    "ContextLengthExceededError",
    "InternalServerError",
]
_ERROR_MESSAGES = {
    "RateLimitError": "429 too many requests; retry-after=5",
    "APITimeoutError": "request exceeded 60s; upstream did not respond",
    "ServiceUnavailableError": "503 service temporarily unavailable",
    "OutputParserException": "could not parse structured output: missing key 'reasoning'",
    "ContextLengthExceededError": "prompt + response exceeds 128k token window",
    "InternalServerError": "500 internal error from provider",
}


def _now_iso(offset_s: float = 0.0) -> str:
    t = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(
        seconds=offset_s
    )
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _post(payload: dict) -> int:
    data = json.dumps(payload).encode()
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
        body = e.read().decode("utf-8", errors="replace")[:200]
        print(f"  HTTP {e.code} body={body}")
        return e.code
    except urllib.error.URLError as e:
        print(f"  URLError reason={e.reason!r}")
        return 0


def _base(session_id: str, agent_id: str, flavor: str, profile: dict,
          event_type: str, *, offset_s: float = 0.0) -> dict:
    # Claude Code profiles override the wire flavor + agent_name so
    # the historical seed lands as a "claude-code" client (matching
    # what the plugin emits live) rather than as a synthetic
    # "claude-code-root" flavor that no live session ever produces.
    flavor_wire = profile.get("flavor_label") or flavor
    agent_name = profile.get("agent_name_override") or (
        f"{flavor}-{profile['agent_name_suffix']}"
    )
    # Match the host/user the plugin actually stamps for claude-code
    # sessions; sensor flavors keep the synthetic demo-host pair.
    user = (_CLAUDE_CODE_USER if profile.get("client_type") == "claude_code"
            else "demo")
    hostname = (_CLAUDE_CODE_HOST if profile.get("client_type") == "claude_code"
                else "demo-host")
    return {
        "session_id": session_id,
        "agent_id": agent_id,
        "agent_type": profile["agent_type"],
        "client_type": profile["client_type"],
        "agent_name": agent_name,
        "user": user,
        "hostname": hostname,
        "flavor": flavor_wire,
        "host": hostname,
        "framework": profile["framework"],
        "model": profile["model"],
        "sensor_version": SENSOR_VERSION,
        "event_type": event_type,
        "timestamp": _now_iso(offset_s),
    }


def build_day_events(flavor: str, profile: dict, day_offset: int,
                     rng: random.Random) -> list[dict]:
    """One historical session for ``flavor`` on day T-``day_offset``.

    Returns the events list in chronological order. All events get
    NOW-stamped timestamps; ``backdate_sql`` rewrites occurred_at +
    session timestamps to ``day_offset`` days ago after the worker
    drains the ingestion queue.

    The ``agent_id`` is picked from one of two derivers:
      * ``profile["agent_id_fn"]`` when present — used for
        ``client_type=claude_code`` agents whose ID must match the
        plugin's D115 UUID5 derivation (``deriveAgentId``) so the
        historical seed and the live plugin land on the same fleet
        row.
      * ``demo_agent_id(flavor)`` otherwise — sensor flavors use the
        repo-local deterministic UUID5 keyed by flavor name.
    """
    session_id = str(uuid.uuid4())
    agent_id_fn = profile.get("agent_id_fn")
    agent_id = agent_id_fn() if callable(agent_id_fn) else demo_agent_id(flavor)

    n_post = rng.randint(*profile["events_per_day"])
    n_tool = rng.randint(*profile["tools_per_day"])

    events: list[dict] = []
    # session_start at offset 0 — small jitter so the seeder doesn't
    # POST every flavor's session_start on the exact same microsecond.
    start = _base(session_id, agent_id, flavor, profile, "session_start",
                  offset_s=rng.uniform(0.0, 0.5))
    # Claude Code-flavored context. The plugin's session_start
    # carries ``arch``, ``node_version``, ``process_name``,
    # ``working_dir``, ``frameworks=["claude-code"]``, etc.; the
    # seed mirrors a representative subset so the AgentDrawer
    # context panel renders sensibly on the historical sessions.
    if profile.get("client_type") == "claude_code":
        start["context"] = {
            "os": "Linux", "arch": "x64",
            "node_version": "v24.15.0",
            "hostname": _CLAUDE_CODE_HOST,
            "user": _CLAUDE_CODE_USER,
            "frameworks": ["claude-code"],
            "process_name": "claude-code",
            "working_dir": "/mnt/c/Users/omria/dev/flightdeck",
            "supports_directives": False,
        }
        # Seed agent_role on session_start so the worker materialises
        # the sessions.agent_role column — the dashboard groups
        # rows by ``agent_name + role`` so the sub-agent rows
        # land as their own agents (general-purpose / Explore /
        # Plan) instead of all collapsing under the parent.
        role = profile.get("agent_role")
        if role:
            start["agent_role"] = role
    else:
        start["context"] = {
            "os": "Linux", "arch": "x86_64",
            "python_version": "3.12.7",
            "hostname": f"demo-{flavor}-host",
            "user": "demo",
            "frameworks": [profile["framework"]],
            "supports_directives": True,
        }
    events.append(start)

    # Interleave post_call + tool_call events in time order. Tokens
    # bias up over the session (multi-call agents accumulate context).
    tlen = n_post + n_tool
    for i in range(tlen):
        if rng.random() < (n_post / tlen) and n_post > 0:
            # post_call
            tokens_in = rng.randint(*profile["tokens_in_range"])
            tokens_out = rng.randint(*profile["tokens_out_range"])
            latency = rng.randint(*profile["latency_range"])
            e = _base(session_id, agent_id, flavor, profile, "post_call",
                      offset_s=rng.uniform(0.6, 2.5))
            e["tokens_input"] = tokens_in
            e["tokens_output"] = tokens_out
            e["tokens_total"] = tokens_in + tokens_out
            e["latency_ms"] = latency
            events.append(e)
            n_post -= 1
        elif n_tool > 0:
            tool_name = rng.choice(profile["tool_names"])
            e = _base(session_id, agent_id, flavor, profile, "tool_call",
                      offset_s=rng.uniform(0.6, 2.5))
            e["tool_name"] = tool_name
            e["latency_ms"] = rng.randint(60, 280)
            events.append(e)
            n_tool -= 1

    # Emit a per-day randomized count of llm_error events so the
    # Errors sparkline gets visible bars on every flavor, not just
    # a single bar on lucky-roll days.
    n_errors = rng.randint(*profile["errors_per_day"])
    for _ in range(n_errors):
        error_type = rng.choice(_ERROR_TYPES)
        e = _base(session_id, agent_id, flavor, profile, "llm_error",
                  offset_s=rng.uniform(0.6, 2.5))
        e["error_type"] = error_type
        e["error_message"] = _ERROR_MESSAGES[error_type]
        e["latency_ms"] = rng.randint(200, 900)
        # Also stamp the structured ``payload.error`` block the
        # worker indexes for facet queries (see events_payload_error_type_idx).
        e["payload"] = {
            "error": {
                "error_type": error_type,
                "error_message": _ERROR_MESSAGES[error_type],
            },
        }
        events.append(e)

    # session_end with normal_exit.
    end = _base(session_id, agent_id, flavor, profile, "session_end",
                offset_s=rng.uniform(0.6, 2.5))
    end["close_reason"] = "normal_exit"
    events.append(end)

    return session_id, events


def post_all(per_day: dict[str, dict[int, tuple[str, list[dict]]]]) -> int:
    """POST every event. Returns number accepted."""
    ok = 0
    total = 0
    for flavor, by_day in per_day.items():
        for day_offset, (session_id, events) in by_day.items():
            for e in events:
                total += 1
                rc = _post(e)
                if rc == 200:
                    ok += 1
    print(f"  posted {ok}/{total} events")
    return ok


def wait_for_drain(per_day: dict, timeout_s: float = 30.0) -> None:
    """Wait for the worker to materialise every session row."""
    target_session_ids = []
    for by_day in per_day.values():
        for session_id, _events in by_day.values():
            target_session_ids.append(session_id)
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        result = subprocess.run(
            ["docker", "exec", POSTGRES_CONTAINER, "psql",
             "-U", "flightdeck", "-d", "flightdeck", "-tAc",
             f"SELECT COUNT(*) FROM sessions WHERE session_id IN "
             f"({','.join(repr(s) + '::uuid' for s in target_session_ids)})"],
            capture_output=True, text=True, timeout=10, check=False,
        )
        if result.returncode == 0:
            try:
                n = int(result.stdout.strip())
            except ValueError:
                n = -1
            if n >= len(target_session_ids):
                print(f"  drain complete: {n}/{len(target_session_ids)} sessions materialised")
                return
        time.sleep(0.5)
    print(f"  warning: drain incomplete after {timeout_s}s, proceeding anyway")


def backdate_sql(per_day: dict[str, dict[int, tuple[str, list[dict]]]]) -> None:
    """Issue one big UPDATE per table backdating events.occurred_at +
    sessions.{started_at,last_seen_at,ended_at} + agents.first_seen_at.

    The dashboard's /v1/agents/:id/summary buckets by
    ``date_trunc('day', occurred_at)``; setting occurred_at to N days
    ago drops every event in that session into the day-N bucket.
    """
    statements: list[str] = []
    agent_ids_seen: set[str] = set()
    for flavor, by_day in per_day.items():
        agent_id = demo_agent_id(flavor)
        for day_offset, (session_id, _events) in by_day.items():
            interval = f"INTERVAL '{day_offset} days'"
            # Backdate every event in this session.
            statements.append(
                f"UPDATE events SET occurred_at = occurred_at - {interval} "
                f"WHERE session_id = '{session_id}'::uuid;"
            )
            statements.append(
                f"UPDATE sessions SET "
                f"started_at = started_at - {interval}, "
                f"last_seen_at = last_seen_at - {interval}, "
                f"ended_at = CASE WHEN ended_at IS NULL THEN NULL "
                f"ELSE ended_at - {interval} END "
                f"WHERE session_id = '{session_id}'::uuid;"
            )
        agent_ids_seen.add(agent_id)
    # Pull each agent's first_seen_at back to its oldest session.
    for agent_id in agent_ids_seen:
        statements.append(
            f"UPDATE agents SET first_seen_at = "
            f"(SELECT MIN(started_at) FROM sessions WHERE agent_id = '{agent_id}'::uuid) "
            f"WHERE agent_id = '{agent_id}'::uuid;"
        )
    sql = "\n".join(statements)
    result = subprocess.run(
        ["docker", "exec", "-i", POSTGRES_CONTAINER, "psql",
         "-U", "flightdeck", "-d", "flightdeck", "-v", "ON_ERROR_STOP=1"],
        input=sql, capture_output=True, text=True, timeout=30, check=False,
    )
    if result.returncode != 0:
        print(f"  ERROR: backdate SQL failed: {result.stderr[:500]}")
        sys.exit(1)
    n_updates = result.stdout.count("UPDATE ")
    print(f"  backdated: {n_updates} UPDATE statements executed")


def main() -> None:
    print("[seed_history] generating 7 days × 7 flavors of synthetic history")
    rng = random.Random(42)  # deterministic so re-runs are stable
    per_day: dict[str, dict[int, tuple[str, list[dict]]]] = {}
    total_events = 0
    for flavor, profile in FLAVOR_PROFILES.items():
        per_day[flavor] = {}
        for day_offset in DAYS_BACK:
            session_id, events = build_day_events(
                flavor, profile, day_offset, rng,
            )
            per_day[flavor][day_offset] = (session_id, events)
            total_events += len(events)
    print(f"  built {total_events} events across "
          f"{sum(len(d) for d in per_day.values())} sessions")

    print("[seed_history] posting all events to ingestion API")
    posted = post_all(per_day)
    if posted == 0:
        print("  no events posted; aborting backdate")
        sys.exit(1)

    print("[seed_history] waiting for worker drain")
    wait_for_drain(per_day)

    print("[seed_history] backdating timestamps")
    backdate_sql(per_day)

    print("[seed_history] done")


if __name__ == "__main__":
    main()
