# TEMPORARY -- DELETE AFTER USE
# UI demonstration test for Phase 4.5
# Run: pytest tests/integration/test_ui_demo.py -v -s --no-header
"""
UI demonstration test. Runs 10 agents across 3 flavors for 2 minutes,
producing realistic event traffic so the dashboard can be viewed in
live action. DELETE THIS FILE AFTER USE.
"""

from __future__ import annotations

import random
import time
import uuid

from .conftest import (
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
    # research-agent: 4 agents
    {"flavor": "research-agent", "agent_type": "production", "model": "claude-sonnet-4-6", "provider": "anthropic"},
    {"flavor": "research-agent", "agent_type": "production", "model": "claude-sonnet-4-6", "provider": "anthropic"},
    {"flavor": "research-agent", "agent_type": "production", "model": "claude-sonnet-4-6", "provider": "anthropic"},
    {"flavor": "research-agent", "agent_type": "production", "model": "claude-sonnet-4-6", "provider": "anthropic"},
    # code-agent: 4 agents
    {"flavor": "code-agent", "agent_type": "production", "model": "gpt-4o", "provider": "openai"},
    {"flavor": "code-agent", "agent_type": "production", "model": "gpt-4o", "provider": "openai"},
    {"flavor": "code-agent", "agent_type": "production", "model": "gpt-4o", "provider": "openai"},
    {"flavor": "code-agent", "agent_type": "production", "model": "gpt-4o", "provider": "openai"},
    # claude-code: 2 agents
    {"flavor": "claude-code", "agent_type": "developer", "model": "claude-sonnet-4-6", "provider": "anthropic"},
    {"flavor": "claude-code", "agent_type": "developer", "model": "claude-sonnet-4-6", "provider": "anthropic"},
]

RESEARCH_TOOLS = ["web_search", "bash", "read_file"]
CODE_TOOLS = ["bash", "read_file", "write_file", "edit"]
CLAUDE_CODE_TOOLS = ["Read", "Write", "Bash", "Glob", "Edit"]


def test_ui_demo() -> None:
    """
    UI demonstration test. Runs 10 agents across 3 flavors for 2 minutes.
    DELETE THIS FILE AFTER USE.
    Run with: pytest tests/integration/test_ui_demo.py -v -s --no-header
    """
    # --- Set up session IDs and tracking ---
    sessions: list[dict] = []
    for i, agent in enumerate(AGENTS):
        sid = str(uuid.uuid4())
        sessions.append({
            "session_id": sid,
            "flavor": agent["flavor"],
            "agent_type": agent["agent_type"],
            "model": agent["model"],
            "provider": agent["provider"],
            "host": f"worker-{i + 1}",
            "tokens_used_session": 0,
            "active": True,
        })

    research_sessions = [s for s in sessions if s["flavor"] == "research-agent"]
    code_sessions = [s for s in sessions if s["flavor"] == "code-agent"]
    claude_sessions = [s for s in sessions if s["flavor"] == "claude-code"]

    policy_id: str | None = None
    policy_created = False
    directive_sent = False

    try:
        # ---- PHASE 1: Start all 10 sessions ----
        print("\n=== PHASE 1: Starting 10 sessions ===")
        for s in sessions:
            evt = make_event(
                s["session_id"],
                s["flavor"],
                "session_start",
                agent_type=s["agent_type"],
                host=s["host"],
                model=s["model"],
            )
            post_event(evt)
            print(f"  Started {s['session_id'][:8]} ({s['flavor']}) on {s['host']}")
            time.sleep(0.5)

        # Wait for all sessions to appear
        for s in sessions:
            wait_for_session_in_fleet(s["session_id"], timeout=10.0)
        print("  All 10 sessions visible in fleet")

        # ---- PHASE 2: Event loop (120 seconds) ----
        print("\n=== PHASE 2: Event loop (120s) ===")
        start = time.monotonic()
        tick = 0

        while time.monotonic() - start < 120:
            tick += 1
            elapsed = int(time.monotonic() - start)
            print(f"\n--- Tick {tick} ({elapsed}s) ---")

            # ---- PHASE 3: Policy at 60 seconds ----
            if elapsed >= 60 and not policy_created:
                policy = create_policy(
                    scope="flavor",
                    scope_value="research-agent",
                    token_limit=50000,
                    warn_at_pct=80,
                )
                policy_id = policy.get("id")
                policy_created = True
                print(f"  ** Created warn policy for research-agent at {elapsed}s (id={policy_id})")

            # ---- PHASE 4: Kill switch at 90 seconds ----
            if elapsed >= 90 and not directive_sent:
                target_sid = research_sessions[0]["session_id"]
                post_directive(
                    action="shutdown",
                    session_id=target_sid,
                    reason="demo kill switch",
                    grace_period_ms=5000,
                )
                research_sessions[0]["active"] = False
                directive_sent = True
                print(f"  ** Sent shutdown directive to research-agent session {target_sid[:8]}")

            for s in sessions:
                if not s["active"]:
                    continue

                flavor = s["flavor"]

                # Determine if this agent posts this tick
                if flavor == "research-agent" and random.random() > 0.60:
                    continue
                if flavor == "code-agent" and random.random() > 0.70:
                    continue
                if flavor == "claude-code" and random.random() > 0.80:
                    continue

                # Determine event type
                if flavor == "research-agent":
                    is_llm = random.random() < 0.70
                elif flavor == "code-agent":
                    is_llm = random.random() < 0.50
                else:  # claude-code
                    is_llm = random.random() < 0.20

                if is_llm:
                    # LLM call
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

                    evt = make_event(
                        s["session_id"],
                        s["flavor"],
                        "post_call",
                        agent_type=s["agent_type"],
                        host=s["host"],
                        model=s["model"],
                        tokens_input=ti,
                        tokens_output=to,
                        tokens_total=tt,
                        tokens_used_session=s["tokens_used_session"],
                        latency_ms=lat,
                    )
                    post_event(evt)
                    print(f"  {s['session_id'][:8]} ({flavor}) -> post_call {s['model']} ({tt} tok)")
                else:
                    # Tool call
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
                        s["session_id"],
                        s["flavor"],
                        "tool_call",
                        agent_type=s["agent_type"],
                        host=s["host"],
                        tool_name=tool,
                        latency_ms=lat,
                        tokens_input=0,
                        tokens_output=0,
                        tokens_total=0,
                        tokens_used_session=s["tokens_used_session"],
                    )
                    post_event(evt)
                    print(f"  {s['session_id'][:8]} ({flavor}) -> tool_call {tool}")

            time.sleep(0.3)

        # ---- PHASE 5: Graceful shutdown ----
        print("\n--- Shutting down all sessions ---")
        for s in sessions:
            if s["active"]:
                evt = make_event(
                    s["session_id"],
                    s["flavor"],
                    "session_end",
                    agent_type=s["agent_type"],
                    host=s["host"],
                )
                post_event(evt)
                print(f"  Ended session {s['session_id'][:8]}")
                time.sleep(0.3)

    finally:
        # ---- CLEANUP ----
        if policy_id:
            delete_policy(policy_id)
            print(f"  Cleaned up policy {policy_id}")

    # ---- ASSERTIONS ----
    fleet = get_fleet()
    assert fleet is not None

    total_events = 0
    for s in sessions:
        total_events += get_session_event_count(s["session_id"])

    assert total_events > 100, f"Expected > 100 events, got {total_events}"

    research_tokens = sum(s["tokens_used_session"] for s in research_sessions)
    code_tokens = sum(s["tokens_used_session"] for s in code_sessions)
    claude_tokens = sum(s["tokens_used_session"] for s in claude_sessions)

    print(f"\n=== Demo complete ===")
    print(f"Sessions: 10")
    print(f"Duration: ~120s")
    print(f"Total events: {total_events}")
    print(f"research-agent tokens: {research_tokens:,}")
    print(f"code-agent tokens: {code_tokens:,}")
    print(f"claude-code tokens: {claude_tokens:,}")
