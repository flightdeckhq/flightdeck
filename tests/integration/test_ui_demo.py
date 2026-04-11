"""Manual UI demonstration tool -- NOT a CI test.

Runs 10 agents across 3 flavors for ~3 minutes, producing realistic
event traffic so the dashboard can be viewed in live action. Useful
for screen recordings, walkthroughs, and visually verifying the
dashboard against a populated stack.

This file is marked ``@pytest.mark.manual`` so it is excluded from
``make test-integration`` and from CI. To run it explicitly::

    pytest tests/integration/test_ui_demo.py -v -s --no-header

Phase 4.5 audit Task 1 reclassified this from a CI test to a manual
data-population tool. The original "DELETE THIS FILE AFTER USE"
comment was removed because the file is genuinely useful as a demo
harness; gating it on the ``manual`` marker keeps it out of the CI
budget without throwing away the work.
"""

from __future__ import annotations

import json
import random
import time
import urllib.error
import urllib.request
import uuid

import pytest

from .conftest import (
    API_URL,
    TOKEN,
    create_policy,
    delete_policy,
    get_fleet,
    get_session_event_count,
    make_event,
    post_directive,
    post_event,
    wait_for_session_in_fleet,
)

# ---- Agent configuration ----

AGENTS = [
    {"flavor": "research-agent", "agent_type": "production", "model": "claude-sonnet-4-6", "provider": "anthropic"},
    {"flavor": "research-agent", "agent_type": "production", "model": "claude-sonnet-4-6", "provider": "anthropic"},
    {"flavor": "research-agent", "agent_type": "production", "model": "claude-sonnet-4-6", "provider": "anthropic"},
    {"flavor": "research-agent", "agent_type": "production", "model": "claude-sonnet-4-6", "provider": "anthropic"},
    {"flavor": "code-agent", "agent_type": "production", "model": "gpt-4o", "provider": "openai"},
    {"flavor": "code-agent", "agent_type": "production", "model": "gpt-4o", "provider": "openai"},
    {"flavor": "code-agent", "agent_type": "production", "model": "gpt-4o", "provider": "openai"},
    {"flavor": "code-agent", "agent_type": "production", "model": "gpt-4o", "provider": "openai"},
    {"flavor": "claude-code", "agent_type": "developer", "model": "claude-sonnet-4-6", "provider": "anthropic"},
    {"flavor": "claude-code", "agent_type": "developer", "model": "claude-sonnet-4-6", "provider": "anthropic"},
]

# Per-agent runtime context attached to each session_start. Matches
# the shape of the sensor's context.py collector output so the
# dashboard's CONTEXT sidebar and RUNTIME panel render the same way
# they would in production. Spread across enough OS / arch /
# orchestration / namespace / user combinations that every multi-
# value facet clears the 2-distinct-values threshold the FleetPanel
# uses to decide whether to show a facet group at all.
AGENT_CONTEXTS: list[dict] = [
    # research-agent (0-3): mix of k8s namespaces + a bare Docker dev box
    {
        "hostname": "k8s-prod-a1", "os": "Linux", "arch": "x86_64",
        "python_version": "3.12.3", "user": "ci-runner",
        "orchestration": "kubernetes", "k8s_namespace": "agents",
        "k8s_node": "node-prod-1", "k8s_pod": "research-a1",
        "git_commit": "abc1234", "git_branch": "main", "git_repo": "flightdeck",
        "frameworks": ["langchain/0.1.12"],
    },
    {
        "hostname": "k8s-prod-a2", "os": "Linux", "arch": "x86_64",
        "python_version": "3.12.3", "user": "ci-runner",
        "orchestration": "kubernetes", "k8s_namespace": "research",
        "k8s_node": "node-prod-1", "k8s_pod": "research-a2",
        "git_commit": "abc1234", "git_branch": "main", "git_repo": "flightdeck",
        "frameworks": ["langchain/0.1.12"],
    },
    {
        "hostname": "k8s-prod-b1", "os": "Linux", "arch": "arm64",
        "python_version": "3.11.9", "user": "ci-runner",
        "orchestration": "kubernetes", "k8s_namespace": "agents",
        "k8s_node": "node-prod-2", "k8s_pod": "research-b1",
        "git_commit": "def5678", "git_branch": "feat/crewai", "git_repo": "flightdeck",
        "frameworks": ["crewai/0.42.0", "langchain/0.1.12"],
    },
    {
        "hostname": "mac-laptop-alice", "os": "Darwin", "arch": "x86_64",
        "python_version": "3.12.3", "user": "alice",
        "orchestration": "docker",
        "git_commit": "abc1234", "git_branch": "main", "git_repo": "flightdeck",
    },
    # code-agent (4-7): docker-compose build pipeline + ECS + bare Mac
    {
        "hostname": "compose-build-1", "os": "Linux", "arch": "x86_64",
        "python_version": "3.11.9", "user": "ci-runner",
        "orchestration": "docker-compose", "compose_project": "build-pipeline",
        "compose_service": "coder-1",
        "git_commit": "abc1234", "git_branch": "main", "git_repo": "flightdeck",
        "frameworks": ["autogen/0.2.34"],
    },
    {
        "hostname": "compose-build-2", "os": "Linux", "arch": "x86_64",
        "python_version": "3.11.9", "user": "ci-runner",
        "orchestration": "docker-compose", "compose_project": "build-pipeline",
        "compose_service": "coder-2",
        "git_commit": "abc1234", "git_branch": "main", "git_repo": "flightdeck",
    },
    {
        "hostname": "ecs-prod-3", "os": "Linux", "arch": "arm64",
        "python_version": "3.12.3", "user": "ci-runner",
        "orchestration": "aws-ecs", "ecs_task": "code-agent:42",
        "git_commit": "def5678", "git_branch": "feat/crewai", "git_repo": "flightdeck",
    },
    {
        "hostname": "mac-laptop-bob", "os": "Darwin", "arch": "arm64",
        "python_version": "3.12.3", "user": "bob",
        "git_commit": "abc1234", "git_branch": "main", "git_repo": "flightdeck",
    },
    # claude-code (8-9): dev laptops, Node.js runtime instead of Python
    {
        "hostname": "alice-mbp", "os": "Darwin", "arch": "arm64",
        "node_version": "v22.11.0", "user": "alice",
        "process_name": "claude-code",
        "git_commit": "abc1234", "git_branch": "main", "git_repo": "flightdeck",
    },
    {
        "hostname": "carol-win", "os": "Windows", "arch": "x86_64",
        "node_version": "v24.14.0", "user": "carol",
        "process_name": "claude-code",
        "git_commit": "feedbeef", "git_branch": "feat/ui", "git_repo": "flightdeck",
    },
]

RESEARCH_TOOLS = ["web_search", "bash", "read_file"]
CODE_TOOLS = ["bash", "read_file", "write_file", "edit"]
CLAUDE_CODE_TOOLS = ["Read", "Write", "Bash", "Glob", "Edit"]

# ---- Prompt capture fixtures ----

ANTHROPIC_PROMPTS = [
    {
        "system": "You are a research assistant. Be thorough and cite sources.",
        "messages": [
            {"role": "user", "content": "Summarize the latest developments in LLM agent frameworks."},
            {"role": "assistant", "content": "Based on recent developments, several frameworks have emerged as leaders in the LLM agent space including LangChain, CrewAI, and AutoGen..."},
        ],
        "tools": [{"name": "web_search", "description": "Search the web", "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}}}],
        "response": {"model": "claude-sonnet-4-6", "usage": {"input_tokens": 450, "output_tokens": 312}, "content": [{"type": "text", "text": "Based on recent developments, several frameworks have emerged..."}]},
    },
    {
        "system": "You are a data analyst specializing in market trends.",
        "messages": [
            {"role": "user", "content": "Analyze token usage patterns across our agent fleet for the past week."},
            {"role": "assistant", "content": "Looking at the fleet data, I can see several patterns emerging in token consumption across flavors..."},
        ],
        "tools": [],
        "response": {"model": "claude-sonnet-4-6", "usage": {"input_tokens": 280, "output_tokens": 190}, "content": [{"type": "text", "text": "Looking at the fleet data..."}]},
    },
]

OPENAI_PROMPTS = [
    {
        "messages": [
            {"role": "system", "content": "You are an expert software engineer. Write clean, tested code."},
            {"role": "user", "content": "Implement a binary search function in Python with full type hints and docstring."},
            {"role": "assistant", "content": "Here is a complete binary search implementation with type hints..."},
        ],
        "tools": [{"type": "function", "function": {"name": "run_tests", "description": "Run the test suite", "parameters": {"type": "object", "properties": {"test_file": {"type": "string"}}}}}],
        "response": {"model": "gpt-4o", "usage": {"prompt_tokens": 320, "completion_tokens": 280}, "choices": [{"message": {"role": "assistant", "content": "Here is a complete binary search implementation..."}}]},
    },
    {
        "messages": [
            {"role": "system", "content": "You are a code reviewer. Be constructive and specific."},
            {"role": "user", "content": "Review this pull request diff and identify any issues."},
            {"role": "assistant", "content": "I reviewed the diff and found 3 issues worth addressing..."},
        ],
        "tools": [],
        "response": {"model": "gpt-4o", "usage": {"prompt_tokens": 180, "completion_tokens": 240}, "choices": [{"message": {"role": "assistant", "content": "I reviewed the diff and found 3 issues..."}}]},
    },
]


def _safe_post(evt: dict) -> bool:
    """Post event, handle 429 rate limiting."""
    try:
        post_event(evt)
        return True
    except urllib.error.HTTPError as e:
        if e.code == 429:
            print("  RATE LIMITED -- sleeping 5s")
            time.sleep(5)
            return False
        raise


# ---- Custom directive catalog ----

# Per-flavor custom directive definitions. These match the shape of
# what the sensor's @flightdeck_sensor.directive() decorator would
# register in production: a name, description, target flavor, and a
# parameter list with per-parameter type/options/default. The demo
# POSTs these via POST /v1/directives/register at the start of
# PHASE 1 so the dashboard's Directives tab (SessionDrawer) and the
# per-flavor Directives button (FleetPanel) have real entries to
# render. The UI reads from GET /v1/directives/custom and filters
# by flavor client-side.
CUSTOM_DIRECTIVES: dict[str, list[dict]] = {
    "research-agent": [
        {
            "name": "refresh_sources",
            "fingerprint": "fp-research-refresh-sources",
            "description": "Invalidate the cached source corpus and re-fetch.",
            "parameters": [
                {
                    "name": "max_age_hours",
                    "type": "integer",
                    "description": "Only refresh sources older than this.",
                    "options": [],
                    "required": False,
                    "default": 24,
                },
                {
                    "name": "dry_run",
                    "type": "boolean",
                    "description": "Simulate without touching the cache.",
                    "options": [],
                    "required": False,
                    "default": False,
                },
            ],
        },
        {
            "name": "switch_search_backend",
            "fingerprint": "fp-research-switch-backend",
            "description": "Route web searches through a different backend.",
            "parameters": [
                {
                    "name": "backend",
                    "type": "string",
                    "description": "Which search backend to use.",
                    "options": ["tavily", "brave", "google", "bing"],
                    "required": True,
                    "default": None,
                },
            ],
        },
    ],
    "code-agent": [
        {
            "name": "rotate_model",
            "fingerprint": "fp-code-rotate-model",
            "description": "Swap the active LLM for subsequent calls.",
            "parameters": [
                {
                    "name": "target_model",
                    "type": "string",
                    "description": "Model to switch to.",
                    "options": [
                        "gpt-4o",
                        "gpt-4o-mini",
                        "claude-sonnet-4-6",
                        "claude-haiku-4-5",
                    ],
                    "required": True,
                    "default": None,
                },
                {
                    "name": "reason",
                    "type": "string",
                    "description": "Why the rotation is needed.",
                    "options": [],
                    "required": False,
                    "default": "",
                },
            ],
        },
        {
            "name": "enable_sandbox",
            "fingerprint": "fp-code-enable-sandbox",
            "description": "Force all code execution into a sandbox container.",
            "parameters": [
                {
                    "name": "timeout_seconds",
                    "type": "integer",
                    "description": "Sandbox wall-clock limit.",
                    "options": [],
                    "required": False,
                    "default": 30,
                },
            ],
        },
        {
            "name": "clear_workspace",
            "fingerprint": "fp-code-clear-workspace",
            "description": "Wipe the agent's scratch workspace directory.",
            "parameters": [],
        },
    ],
    "claude-code": [
        {
            "name": "toggle_autonomy",
            "fingerprint": "fp-cc-toggle-autonomy",
            "description": "Flip between supervised and autonomous modes.",
            "parameters": [
                {
                    "name": "mode",
                    "type": "string",
                    "description": "Supervision mode for the rest of the session.",
                    "options": ["supervised", "autonomous"],
                    "required": True,
                    "default": "supervised",
                },
            ],
        },
        {
            "name": "set_context_budget",
            "fingerprint": "fp-cc-set-context-budget",
            "description": "Adjust the maximum context window tokens.",
            "parameters": [
                {
                    "name": "max_tokens",
                    "type": "integer",
                    "description": "Context window cap.",
                    "options": [],
                    "required": True,
                    "default": 200_000,
                },
            ],
        },
    ],
}


def register_custom_directives() -> int:
    """POST each flavor's directive catalog to /v1/directives/register.

    The endpoint is authed with the same bearer token as the
    ingestion API (D073 stopgap auth). Returns the total number of
    directives registered across all flavors so the caller can print
    a summary line.
    """
    total = 0
    for flavor, directives in CUSTOM_DIRECTIVES.items():
        body = {
            "flavor": flavor,
            "directives": [
                {
                    "name": d["name"],
                    "fingerprint": d["fingerprint"],
                    "description": d["description"],
                    "flavor": flavor,
                    "parameters": d["parameters"],
                }
                for d in directives
            ],
        }
        req = urllib.request.Request(
            f"{API_URL}/v1/directives/register",
            data=json.dumps(body).encode(),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {TOKEN}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            payload = json.loads(resp.read())
            total += int(payload.get("registered", 0))
    return total


@pytest.mark.manual
def test_ui_demo() -> None:
    """
    UI demonstration test. Runs 10 agents across 3 flavors for 3 minutes.
    DELETE THIS FILE AFTER USE.
    Run with: pytest tests/integration/test_ui_demo.py -v -s --no-header
    """
    sessions: list[dict] = []
    for i, agent in enumerate(AGENTS):
        sid = str(uuid.uuid4())
        ctx = AGENT_CONTEXTS[i]
        sessions.append({
            "session_id": sid,
            "flavor": agent["flavor"],
            "agent_type": agent["agent_type"],
            "model": agent["model"],
            "provider": agent["provider"],
            # Use the context hostname so the drawer Host field and
            # the swimlane hostname label show the same value for
            # each demo session.
            "host": ctx["hostname"],
            "context": ctx,
            "tokens_used_session": 0,
        })

    research_sessions = [s for s in sessions if s["flavor"] == "research-agent"]
    code_sessions = [s for s in sessions if s["flavor"] == "code-agent"]
    claude_sessions = [s for s in sessions if s["flavor"] == "claude-code"]

    # Tracks session IDs that have received session_end (or had a
    # shutdown directive acknowledged). The main event loop skips
    # any session in this set so no LLM/tool circles are posted to
    # a session after its END marker -- this used to leave dangling
    # circles past the END circle in the swimlane.
    inactive_sessions: set[str] = set()

    policy_id: str | None = None
    policy_created = False
    directive_sent = False
    flow1_done = False
    flow2_done = False
    flow3_done = False
    flow4_done = False

    def now_iso() -> str:
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    try:
        # ---- PHASE 0: Register custom directives ----
        # Runs before PHASE 1 so the directives are already present
        # when the fleet store's initial load picks them up -- the
        # dashboard only refetches custom directives on full page
        # load, not on WebSocket update.
        print("\n=== PHASE 0: Registering custom directives ===")
        try:
            registered = register_custom_directives()
            print(
                f"  Registered {registered} custom directives across "
                f"{len(CUSTOM_DIRECTIVES)} flavors"
            )
        except urllib.error.HTTPError as e:
            print(f"  WARN: register failed ({e.code}) -- UI directives tab will be empty")

        # ---- PHASE 1: Start all 10 sessions ----
        print("\n=== PHASE 1: Starting 10 sessions ===")
        for s in sessions:
            # session_start carries the per-session runtime context so
            # the worker persists it once in sessions.context and the
            # dashboard CONTEXT sidebar / RUNTIME drawer panel have
            # real data to render.
            evt = make_event(
                s["session_id"], s["flavor"], "session_start",
                agent_type=s["agent_type"], host=s["host"], model=s["model"],
                context=s["context"],
            )
            _safe_post(evt)
            print(f"  Started {s['session_id'][:8]} ({s['flavor']}) on {s['host']}")
            time.sleep(0.5)

        for s in sessions:
            wait_for_session_in_fleet(s["session_id"], timeout=10.0)
        print("  All 10 sessions visible in fleet")

        # ---- PHASE 2: Event loop (180 seconds) ----
        print("\n=== PHASE 2: Event loop (180s) ===")
        start = time.monotonic()
        tick = 0

        while time.monotonic() - start < 180:
            tick += 1
            elapsed = int(time.monotonic() - start)
            print(f"\n--- Tick {tick} ({elapsed}s) ---")

            # ---- Flow 1: Custom directive at 60s ----
            if elapsed >= 60 and not flow1_done:
                flow1_done = True
                target = research_sessions[1]["session_id"]
                _safe_post(make_event(target, "research-agent", "directive_result",
                    agent_type="production", host=research_sessions[1]["host"],
                    directive_name="clear_cache", directive_action="custom",
                    directive_status="success",
                ))
                print(f"  ** Flow 1: clear_cache directive result for {target[:8]}")

            # ---- Flow 2: Degrade result at 75s ----
            if elapsed >= 75 and not flow2_done:
                flow2_done = True
                target = research_sessions[2]["session_id"]
                _safe_post(make_event(target, "research-agent", "directive_result",
                    agent_type="production", host=research_sessions[2]["host"],
                    directive_name="degrade", directive_action="degrade",
                    directive_status="acknowledged",
                ))
                print(f"  ** Flow 2: degrade result for {target[:8]}")

            # ---- PHASE 3: Policy at 90 seconds ----
            if elapsed >= 90 and not policy_created:
                policy = create_policy(
                    scope="flavor", scope_value="research-agent",
                    token_limit=50000, warn_at_pct=80,
                )
                policy_id = policy.get("id")
                policy_created = True
                print(f"  ** Created warn policy for research-agent at {elapsed}s (id={policy_id})")

            # ---- Flow 3: Failed directive at 90s ----
            if elapsed >= 90 and not flow3_done:
                flow3_done = True
                target = code_sessions[0]["session_id"]
                _safe_post(make_event(target, "code-agent", "directive_result",
                    agent_type="production", host=code_sessions[0]["host"],
                    directive_name="unknown_action", directive_action="custom",
                    directive_status="error",
                ))
                print(f"  ** Flow 3: failed directive result for {target[:8]}")

            # ---- Flow 4 + PHASE 4: Shutdown with ack at 135 seconds ----
            if elapsed >= 135 and not directive_sent:
                target_sid = research_sessions[0]["session_id"]
                post_directive(
                    action="shutdown", session_id=target_sid,
                    reason="demo kill switch", grace_period_ms=5000,
                )
                time.sleep(2)
                # Post acknowledgement result
                _safe_post(make_event(target_sid, "research-agent", "directive_result",
                    agent_type="production", host=research_sessions[0]["host"],
                    directive_name="shutdown", directive_action="shutdown",
                    directive_status="acknowledged",
                ))
                # Post session_end so the swimlane shows a clean END marker
                # and mark the session inactive so the event loop stops
                # posting to it from this tick onward.
                _safe_post(make_event(
                    target_sid, "research-agent", "session_end",
                    agent_type="production", host=research_sessions[0]["host"],
                ))
                inactive_sessions.add(target_sid)
                directive_sent = True
                flow4_done = True
                print(f"  ** Flow 4: shutdown acknowledged and session ended for {target_sid[:8]}")

            # Filter sessions by inactive set BEFORE the per-session loop
            # so events are only posted to currently-active sessions.
            active_research = [s for s in research_sessions if s["session_id"] not in inactive_sessions]
            active_code = [s for s in code_sessions if s["session_id"] not in inactive_sessions]
            active_claude = [s for s in claude_sessions if s["session_id"] not in inactive_sessions]

            if not (active_research or active_code or active_claude):
                print("  All sessions inactive -- ending event loop early")
                break

            for s in active_research + active_code + active_claude:
                flavor = s["flavor"]

                # Reduced probabilities to avoid rate limiting
                if flavor == "research-agent" and random.random() > 0.40:
                    continue
                if flavor == "code-agent" and random.random() > 0.50:
                    continue
                if flavor == "claude-code" and random.random() > 0.60:
                    continue

                if flavor == "research-agent":
                    is_llm = random.random() < 0.70
                elif flavor == "code-agent":
                    is_llm = random.random() < 0.50
                else:
                    is_llm = random.random() < 0.20

                if is_llm:
                    if flavor == "research-agent":
                        ti = random.randint(600, 1800)
                        to = random.randint(200, 600)
                        lat = random.randint(800, 3000)
                    elif flavor == "code-agent":
                        ti = random.randint(300, 900)
                        to = random.randint(100, 300)
                        lat = random.randint(400, 1500)
                    else:
                        ti = random.randint(150, 400)
                        to = random.randint(50, 150)
                        lat = random.randint(300, 1200)

                    tt = ti + to
                    s["tokens_used_session"] += tt

                    # Build event with prompt capture for research-agent and code-agent
                    extra: dict = dict(
                        agent_type=s["agent_type"], host=s["host"], model=s["model"],
                        tokens_input=ti, tokens_output=to, tokens_total=tt,
                        tokens_used_session=s["tokens_used_session"], latency_ms=lat,
                    )

                    if flavor == "research-agent":
                        prompt = random.choice(ANTHROPIC_PROMPTS)
                        extra["has_content"] = True
                        extra["content"] = {
                            "system": prompt["system"],
                            "messages": prompt["messages"],
                            "tools": prompt["tools"],
                            "response": prompt["response"],
                            "provider": "anthropic",
                        }
                    elif flavor == "code-agent":
                        prompt = random.choice(OPENAI_PROMPTS)
                        extra["has_content"] = True
                        extra["content"] = {
                            "system": None,
                            "messages": prompt["messages"],
                            "tools": prompt["tools"],
                            "response": prompt["response"],
                            "provider": "openai",
                        }

                    evt = make_event(s["session_id"], s["flavor"], "post_call", **extra)
                    _safe_post(evt)
                    cap = " +prompts" if extra.get("has_content") else ""
                    print(f"  {s['session_id'][:8]} ({flavor}) -> post_call {s['model']} ({tt} tok){cap}")
                else:
                    if flavor == "research-agent":
                        tool = random.choice(RESEARCH_TOOLS)
                        lat = random.randint(100, 800)
                    elif flavor == "code-agent":
                        tool = random.choice(CODE_TOOLS)
                        lat = random.randint(50, 500)
                    else:
                        tool = random.choice(CLAUDE_CODE_TOOLS)
                        lat = random.randint(30, 300)

                    evt = make_event(
                        s["session_id"], s["flavor"], "tool_call",
                        agent_type=s["agent_type"], host=s["host"], tool_name=tool,
                        latency_ms=lat, tokens_input=0, tokens_output=0, tokens_total=0,
                        tokens_used_session=s["tokens_used_session"],
                    )
                    _safe_post(evt)
                    print(f"  {s['session_id'][:8]} ({flavor}) -> tool_call {tool}")

            time.sleep(1.0 + random.uniform(-0.2, 0.2))

        # ---- PHASE 5: Graceful shutdown ----
        print("\n--- Shutting down all sessions ---")
        for s in sessions:
            if s["session_id"] in inactive_sessions:
                continue
            evt = make_event(
                s["session_id"], s["flavor"], "session_end",
                agent_type=s["agent_type"], host=s["host"],
            )
            _safe_post(evt)
            inactive_sessions.add(s["session_id"])
            print(f"  Ended session {s['session_id'][:8]}")
            time.sleep(0.3)

    finally:
        if policy_id:
            delete_policy(policy_id)
            print(f"  Cleaned up policy {policy_id}")

    # ---- ASSERTIONS ----
    fleet = get_fleet()
    assert fleet is not None

    total_events = 0
    for s in sessions:
        total_events += get_session_event_count(s["session_id"])

    assert total_events > 50, f"Expected > 50 events, got {total_events}"

    research_tokens = sum(s["tokens_used_session"] for s in research_sessions)
    code_tokens = sum(s["tokens_used_session"] for s in code_sessions)
    claude_tokens = sum(s["tokens_used_session"] for s in claude_sessions)

    print(f"\n=== Demo complete ===")
    print(f"Sessions: 10")
    print(f"Duration: ~180s")
    print(f"Total events: {total_events}")
    print(f"research-agent tokens: {research_tokens:,}")
    print(f"code-agent tokens: {code_tokens:,}")
    print(f"claude-code tokens: {claude_tokens:,}")
