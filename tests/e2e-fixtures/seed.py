"""Seed canonical E2E fixtures into a running dev stack.

Runs as:

    python3 tests/e2e-fixtures/seed.py

Reads ``canonical.json`` (sibling file) and emits events to the
ingestion API with identity fields that match the D115 vocabulary.
Session IDs derive deterministically from ``uuid5(NAMESPACE,
'flightdeck-e2e/<agent_name>/<role>')`` so each seed run addresses
the same sessions and the operation is idempotent — a repeat run
against an already-seeded DB is a no-op per session.

Used by ``dashboard/tests/e2e/globalSetup.ts`` as the Playwright
globalSetup hook and exposed to developers via ``make seed-e2e``
for fixture iteration.

Three sessions per role follow the declarative timeline in
canonical.json. For ``aged-closed`` and ``stale`` the worker stamps
``last_seen_at = NOW()`` on write, so after the event sequence
lands we back-date the session row directly via ``docker exec
psql`` — the same pattern ``test_session_states.py:269`` uses to
simulate aged sessions.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys
import time
import urllib.error
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid5

# Make ``tests.shared.fixtures`` importable when the script runs
# standalone (not under pytest). Walks up two levels:
# tests/e2e-fixtures/seed.py -> tests/ -> repo root.
_REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from tests.shared.fixtures import (  # noqa: E402
    API_URL,
    INGESTION_URL,
    auth_headers,
    get_session,
    make_event,
    post_event,
    wait_for_services,
    wait_for_session_in_fleet,
)

# NAMESPACE_FLIGHTDECK mirrors sensor/flightdeck_sensor/core/agent_id.py.
# Imported verbatim here rather than re-importing the sensor module so
# seed.py stays runnable even in environments where the sensor isn't
# installed (though make_event itself pulls sensor in). Keeps the
# failure mode "import error on helper" rather than "silent fallback
# to a different namespace".
NAMESPACE_FLIGHTDECK = UUID("ee22ab58-26fc-54ef-91b4-b5c0a97f9b61")

CANONICAL_PATH = pathlib.Path(__file__).resolve().parent / "canonical.json"

# Minimum events per seeded session. Used by ``session_is_complete`` as
# the idempotency signal: a session with at least this many events is
# considered fully seeded. session_start + pre_call + post_call = 3 is
# the floor; closed sessions get +session_end (4), and every role
# emits a tool_call/tool_result pair on top so the real counts are
# 5-6.
MIN_EVENTS_FOR_COMPLETE = 3

# Seed cap: how long to wait for the worker to catch up once all
# events are posted before T_TEST starts reading the fleet.
SEED_READY_TIMEOUT_SEC = 30


def _derive_session_id(agent_name: str, role: str) -> str:
    return str(uuid5(NAMESPACE_FLIGHTDECK, f"flightdeck-e2e/{agent_name}/{role}"))


def _shift_timestamp(offset_sec: int) -> str:
    """Return an ISO-8601 UTC timestamp ``offset_sec`` from now.

    Negative offsets point to the past. The ingestion API accepts
    past-dated event timestamps but the worker ultimately stamps
    ``last_seen_at = NOW()`` on writes (see
    workers/internal/writer/postgres.go), so for aged-closed / stale
    roles the post-seed SQL backdate is the load-bearing adjustment,
    not this.
    """
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + offset_sec))


def _post_session_events(
    *,
    agent_cfg: dict[str, Any],
    session_id: str,
    role_cfg: dict[str, Any],
) -> int:
    """Emit the declarative event timeline for a single session role.

    Posts session_start first and waits for the worker to persist the
    sessions row before posting followups -- out-of-order processing
    under NATS's worker pool can land a session_end before its
    session_start, which trips the events FK constraint. The wait is
    cheap (typically <200 ms) and converts a race into a serialized
    write path.

    Each role lands session_start, a pre_call/post_call pair with
    token usage (exercises the dashboard's token columns), and a
    tool_call event carrying both tool_name/tool_input AND tool_result
    on the single payload (the system has no separate tool_result
    event type — workers/internal/processor/event.go recognises only
    session_start / session_end / heartbeat / directive_result and
    lazy-creates on pre_call/post_call/tool_call). Closed roles add
    session_end at ``ended_offset_sec``.

    Returns the count of events successfully posted.
    """
    started = int(role_cfg["started_offset_sec"])
    ended = role_cfg["ended_offset_sec"]

    # Ingestion enforces a clock-skew bound (D7 in audit-phase-4.md):
    # rejects events with ``occurred_at < NOW() - 48h`` with HTTP 400.
    # Roles that backdate the session row beyond that window
    # (currently ``ancient-only`` at -9 days) emit their EVENTS at a
    # recent timestamp clamped to within the bound, then the
    # post-seed SQL backdate moves the session row's started_at /
    # ended_at columns to the declared deep-past values. The events
    # table still carries recent occurred_at values; the dashboard
    # reads ``session.started_at`` for the V-DRAWER drawer query so
    # the ancient session shows up correctly post-fix.
    MAX_SAFE_EVENT_OFFSET = -3600  # 1h ago, well inside the 48h bound
    event_started = max(started, MAX_SAFE_EVENT_OFFSET)
    event_ended = max(int(ended), MAX_SAFE_EVENT_OFFSET + 60) if ended is not None else None

    identity = {
        "agent_type": agent_cfg["agent_type"],
        "client_type": agent_cfg["client_type"],
        "user": agent_cfg["user"],
        "hostname": agent_cfg["hostname"],
        "agent_name": agent_cfg["agent_name"],
    }
    # D126 § 2 — when the role declares ``agent_role``, thread it
    # through every event so the agent_id derivation upstream
    # (fixtures.py::_identity_fields) places the child under a
    # distinct UUID from the parent. Skipped for non-D126 roles so
    # the existing fixtures stay byte-identical to pre-step-8.
    role_for_id = role_cfg.get("agent_role")
    if role_for_id:
        identity["agent_role"] = role_for_id
    common = {
        "host": agent_cfg["host"],
        "framework": agent_cfg["framework"],
        "model": agent_cfg["model"],
    }

    # 1. session_start, then wait for persistence.
    #
    # Phase 5 T25: when the role declares ``mcp_servers``, attach the
    # fingerprint list as ``context.mcp_servers`` on session_start so
    # the worker persists it into ``sessions.context`` (set-once
    # semantics — see ARCHITECTURE.md). Subsequent reads via the
    # listing's ``mcp_server_names[]`` aggregation and the detail
    # endpoint's ``context`` envelope both surface this list. Other
    # roles emit session_start without context, matching the
    # pre-Phase-5 baseline.
    session_start_kwargs: dict[str, Any] = {}
    role_mcp_servers = role_cfg.get("mcp_servers")
    if role_mcp_servers:
        session_start_kwargs["context"] = {"mcp_servers": role_mcp_servers}

    # D126 § 3 — sub-agent linkage. When the role declares
    # ``parent_role`` + ``parent_agent``, resolve the parent's
    # session_id deterministically and stamp ``parent_session_id``
    # on session_start. Per D126 § 3 the parent_session_id FK is
    # enforced; the agents-order in canonical.json guarantees the
    # parent's session lands before this child's session_start.
    parent_role_ref = role_cfg.get("parent_role")
    parent_agent_ref = role_cfg.get("parent_agent")
    if parent_role_ref and parent_agent_ref:
        session_start_kwargs["parent_session_id"] = _derive_session_id(
            parent_agent_ref,
            parent_role_ref,
        )

    # D126 § 6 — cross-agent message capture. ``captured_input``
    # rides on session_start as ``incoming_message``; ``captured_
    # output`` rides on session_end as ``outgoing_message``. The
    # special sentinel ``"OVERFLOW"`` for captured_input synthesises
    # a >8 KiB body via the D119 overflow path: ``has_content=true``
    # on the inline incoming_message + the full body in the wire-
    # level ``content`` envelope so the worker lands it in
    # event_content (and ``GET /v1/events/{id}/content`` resolves).
    captured_input = role_cfg.get("captured_input")
    if captured_input == "OVERFLOW":
        # Wire shape mirrors workers/internal/consumer/nats.go::SubagentMessage.
        # Overflow case: has_content=true + content_bytes; the
        # full body lands in event_content via the ``content``
        # envelope on the session_start payload.
        overflow_body = "OVERFLOW INPUT BODY — " + ("x" * 9000)
        session_start_kwargs["incoming_message"] = {
            "captured_at": _shift_timestamp(event_started),
            "has_content": True,
            "content_bytes": len(overflow_body),
        }
        session_start_kwargs["has_content"] = True
        session_start_kwargs["content"] = {
            "provider": "flightdeck-subagent",
            "model": agent_cfg["model"],
            "system": None,
            "messages": [],
            "tools": None,
            "response": {},
            "input": overflow_body,
            "session_id": session_id,
            "event_id": "",
            "captured_at": _shift_timestamp(event_started),
        }
    elif captured_input:
        # Inline case: ``body`` carries the framework-supplied
        # payload (string for Claude Code Task subagent prompts;
        # CrewAI / LangGraph fixtures here use strings too because
        # the canonical fixtures are operator-readable text).
        session_start_kwargs["incoming_message"] = {
            "body": captured_input,
            "captured_at": _shift_timestamp(event_started),
        }

    post_event(
        make_event(
            session_id,
            agent_cfg["flavor"],
            "session_start",
            timestamp=_shift_timestamp(event_started),
            **identity,
            **common,
            **session_start_kwargs,
        )
    )
    if wait_for_session_in_fleet(session_id, timeout=5.0) is None:
        print(
            f"  warn: {session_id[:8]} session_start did not surface in 5s; "
            f"subsequent event inserts may FK-violate",
            file=sys.stderr,
        )

    posted = 1

    # 2. pre_call / post_call pair (tokens on post).
    post_event(
        make_event(
            session_id,
            agent_cfg["flavor"],
            "pre_call",
            timestamp=_shift_timestamp(event_started + 5),
            tokens_input=240,
            tokens_used_session=240,
            **identity,
            **common,
        )
    )
    post_event(
        make_event(
            session_id,
            agent_cfg["flavor"],
            "post_call",
            timestamp=_shift_timestamp(event_started + 8),
            tokens_input=240,
            tokens_output=80,
            tokens_total=320,
            tokens_used_session=320,
            latency_ms=3100,
            **identity,
            **common,
        )
    )
    posted += 2

    # 3. tool_call carrying both input and result on one payload.
    post_event(
        make_event(
            session_id,
            agent_cfg["flavor"],
            "tool_call",
            timestamp=_shift_timestamp(event_started + 10),
            tool_name="read_file",
            tool_input={"path": "/tmp/e2e.txt"},
            tool_result={"ok": True, "bytes": 42},
            **identity,
            **common,
        )
    )
    posted += 1

    # 4. session_end for closed roles.
    if ended is not None:
        session_end_kwargs: dict[str, Any] = {}
        captured_output = role_cfg.get("captured_output")
        if captured_output:
            # D126 § 6 — outgoing_message rides on session_end. No
            # overflow case for output bodies in this fixture set;
            # all canonical outputs fit inline. Wire shape mirrors
            # workers/internal/consumer/nats.go::SubagentMessage.
            session_end_kwargs["outgoing_message"] = {
                "body": captured_output,
                "captured_at": _shift_timestamp(
                    int(event_ended) if event_ended is not None else int(ended),
                ),
            }
        post_event(
            make_event(
                session_id,
                agent_cfg["flavor"],
                "session_end",
                timestamp=_shift_timestamp(
                    int(event_ended) if event_ended is not None else int(ended)
                ),
                **identity,
                **common,
                **session_end_kwargs,
            )
        )
        posted += 1

    # 5. Phase 4 polish extras. ``role_cfg["phase4_extras"]`` lists
    # additional event-shape strings the seeder emits on top of the
    # base timeline; canonical.json carries the per-role list. Each
    # extra is timestamped relative to ``started`` so the ordering
    # matches the role's purpose statement, and offsets stay inside
    # the role's span (active roles: positive offsets from start;
    # closed roles: between started and ended). Unknown strings
    # warn and continue so a typo doesn't abort the seed.
    extras: list[str] = list(role_cfg.get("phase4_extras") or [])
    for i, extra in enumerate(extras):
        # Offset progression: extras emit at started+12s, +14s, +16s,
        # ... so they cluster after the base tool_call (started+10s)
        # and well inside the active role's "fresh" window.
        ts = _shift_timestamp(event_started + 12 + 2 * i)
        if extra == "embeddings":
            # Embeddings calls override the agent's default chat model
            # with an embedding model -- the row's getEventDetail
            # branch reads `event.model` so the test asserts on the
            # specific embedding model name. No content captured
            # (has_content defaults to False) -- exercises T14's
            # "(content not captured)" branch.
            embed_common = {**common, "model": "text-embedding-3-small"}
            post_event(
                make_event(
                    session_id,
                    agent_cfg["flavor"],
                    "embeddings",
                    timestamp=ts,
                    tokens_input=1024,
                    tokens_used_session=320 + 1024,
                    latency_ms=180,
                    **identity,
                    **embed_common,
                )
            )
            posted += 1
        elif extra == "embeddings_with_content_string":
            # Embedding event with capture: single-string input.
            # Exercises T14's truncated-text + expand-on-click branch
            # of EmbeddingsContentViewer.
            embed_common = {**common, "model": "text-embedding-3-small"}
            post_event(
                make_event(
                    session_id,
                    agent_cfg["flavor"],
                    "embeddings",
                    timestamp=ts,
                    tokens_input=512,
                    tokens_used_session=320 + 512,
                    latency_ms=140,
                    has_content=True,
                    content={
                        "provider": "openai",
                        "model": "text-embedding-3-small",
                        "system": None,
                        "messages": [],
                        "tools": None,
                        "response": {},
                        "input": "phase 4 e2e seeded embedding string content for T14 capture branch",
                        "session_id": session_id,
                        "event_id": "",
                        "captured_at": "2026-04-25T00:00:00Z",
                    },
                    **identity,
                    **embed_common,
                )
            )
            posted += 1
        elif extra == "embeddings_with_content_list":
            # Embedding event with capture: list-of-strings input.
            # Exercises T14's "<N> inputs" pill + expand-to-list
            # branch of EmbeddingsContentViewer.
            embed_common = {**common, "model": "text-embedding-3-small"}
            post_event(
                make_event(
                    session_id,
                    agent_cfg["flavor"],
                    "embeddings",
                    timestamp=ts,
                    tokens_input=384,
                    tokens_used_session=320 + 384,
                    latency_ms=160,
                    has_content=True,
                    content={
                        "provider": "openai",
                        "model": "text-embedding-3-small",
                        "system": None,
                        "messages": [],
                        "tools": None,
                        "response": {},
                        "input": [
                            "phase 4 e2e item one",
                            "phase 4 e2e item two",
                            "phase 4 e2e item three",
                        ],
                        "session_id": session_id,
                        "event_id": "",
                        "captured_at": "2026-04-25T00:00:00Z",
                    },
                    **identity,
                    **embed_common,
                )
            )
            posted += 1
        elif extra == "streaming_post_call":
            post_event(
                make_event(
                    session_id,
                    agent_cfg["flavor"],
                    "post_call",
                    timestamp=ts,
                    tokens_input=120,
                    tokens_output=240,
                    tokens_total=360,
                    tokens_used_session=320 + 360,
                    latency_ms=4500,
                    streaming={
                        "ttft_ms": 320,
                        "chunk_count": 42,
                        "inter_chunk_ms": {"p50": 25, "p95": 80, "max": 150},
                        "final_outcome": "completed",
                        "abort_reason": None,
                    },
                    **identity,
                    **common,
                )
            )
            posted += 1
        elif extra == "streaming_post_call_aborted":
            post_event(
                make_event(
                    session_id,
                    agent_cfg["flavor"],
                    "post_call",
                    timestamp=ts,
                    tokens_input=80,
                    tokens_output=18,
                    tokens_total=98,
                    tokens_used_session=320 + 98,
                    latency_ms=2100,
                    streaming={
                        "ttft_ms": 380,
                        "chunk_count": 7,
                        "inter_chunk_ms": {"p50": 30, "p95": 90, "max": 220},
                        "final_outcome": "aborted",
                        "abort_reason": "client_aborted",
                    },
                    **identity,
                    **common,
                )
            )
            posted += 1
        elif extra.startswith("policy_"):
            # Policy enforcement events. Three variants:
            #   policy_warn      -- threshold crossed; call proceeded.
            #   policy_degrade   -- threshold crossed; model swapped.
            #   policy_block     -- threshold crossed; call refused.
            # Source is hardcoded "server" because that's where the
            # closed-vocabulary fixtures need to land for the T17 spec
            # (see audit-phase-4.md methodology lessons + DECISIONS D035).
            policy_event_type = extra
            base_payload: dict[str, Any] = {
                "source": "server",
                "threshold_pct": 80
                if policy_event_type == "policy_warn"
                else 90
                if policy_event_type == "policy_degrade"
                else 100,
                "tokens_used": 8000
                if policy_event_type == "policy_warn"
                else 9100
                if policy_event_type == "policy_degrade"
                else 10100,
                "token_limit": 10000,
            }
            if policy_event_type == "policy_degrade":
                base_payload["from_model"] = "claude-sonnet-4-6"
                base_payload["to_model"] = "claude-haiku-4-5"
            elif policy_event_type == "policy_block":
                base_payload["intended_model"] = "claude-opus-4-7"
            post_event(
                make_event(
                    session_id,
                    agent_cfg["flavor"],
                    policy_event_type,
                    timestamp=ts,
                    **base_payload,
                    **identity,
                    **common,
                )
            )
            posted += 1
        elif extra.startswith("mcp_"):
            # Phase 5 — MCP event extras. Six event types, lean wire
            # shape (no LLM-baseline fields). The seeded ``server_name``
            # / ``transport`` use the first entry on the role's
            # ``mcp_servers`` list so per-event attribution lines up
            # with the session-level fingerprint the drawer shows.
            # capture_prompts ON for ``mcp_tool_call`` (arguments +
            # result), ``mcp_resource_read`` (content + mime), and
            # ``mcp_prompt_get`` (arguments + rendered) so T25's
            # capture-on assertions have something to read; the list
            # variants don't have capture-gated content.
            servers = role_cfg.get("mcp_servers") or []
            if not servers:
                # The mcp-active role declares ``mcp_servers``; without
                # it we can't seed coherent per-event attribution.
                # Skip with a warn rather than panic.
                print(
                    f"  warn: extras tag {extra!r} requires role.mcp_servers; "
                    f"skipping for {session_id[:8]}",
                    file=sys.stderr,
                )
                continue
            srv = servers[0]
            srv_name = srv["name"]
            srv_transport = srv["transport"]
            mcp_common: dict[str, Any] = {
                "server_name": srv_name,
                "transport": srv_transport,
                "duration_ms": 18 + 4 * i,
            }
            if extra == "mcp_tool_list":
                post_event(
                    make_event(
                        session_id,
                        agent_cfg["flavor"],
                        "mcp_tool_list",
                        timestamp=ts,
                        count=3,
                        **mcp_common,
                        **identity,
                        **common,
                    )
                )
                posted += 1
            elif extra == "mcp_tool_call":
                post_event(
                    make_event(
                        session_id,
                        agent_cfg["flavor"],
                        "mcp_tool_call",
                        timestamp=ts,
                        tool_name="echo",
                        arguments={"text": "phase5-fixture"},
                        result={
                            "content": [
                                {"type": "text", "text": "phase5-fixture"},
                            ],
                            "isError": False,
                        },
                        **mcp_common,
                        **identity,
                        **common,
                    )
                )
                posted += 1
            elif extra == "mcp_tool_call_failed":
                # Phase 5 — failed MCP tool call. Anchors the
                # MCPErrorIndicator E2E assertion (T25-16). The wire
                # ``error`` shape mirrors
                # sensor/flightdeck_sensor/interceptor/mcp.py::
                # _classify_mcp_error so the dashboard sees the same
                # structure a real sensor would emit.
                post_event(
                    make_event(
                        session_id,
                        agent_cfg["flavor"],
                        "mcp_tool_call",
                        timestamp=ts,
                        tool_name="search_database",
                        arguments={"query": "users where status='banned'"},
                        error={
                            "error_type": "invalid_params",
                            "error_class": "McpError",
                            "message": ("Invalid SQL: 'banned' is not a recognized status"),
                            "code": -32602,
                        },
                        **mcp_common,
                        **identity,
                        **common,
                    )
                )
                posted += 1
            elif extra == "mcp_resource_list":
                post_event(
                    make_event(
                        session_id,
                        agent_cfg["flavor"],
                        "mcp_resource_list",
                        timestamp=ts,
                        count=1,
                        **mcp_common,
                        **identity,
                        **common,
                    )
                )
                posted += 1
            elif extra == "mcp_resource_read":
                post_event(
                    make_event(
                        session_id,
                        agent_cfg["flavor"],
                        "mcp_resource_read",
                        timestamp=ts,
                        resource_uri="mem://demo",
                        content_bytes=46,
                        mime_type="text/plain",
                        content={
                            "contents": [
                                {
                                    "uri": "mem://demo",
                                    "mimeType": "text/plain",
                                    "text": ("hello from the flightdeck reference MCP server"),
                                },
                            ],
                        },
                        **mcp_common,
                        **identity,
                        **common,
                    )
                )
                posted += 1
            elif extra == "mcp_prompt_list":
                post_event(
                    make_event(
                        session_id,
                        agent_cfg["flavor"],
                        "mcp_prompt_list",
                        timestamp=ts,
                        count=1,
                        **mcp_common,
                        **identity,
                        **common,
                    )
                )
                posted += 1
            elif extra == "mcp_prompt_get":
                post_event(
                    make_event(
                        session_id,
                        agent_cfg["flavor"],
                        "mcp_prompt_get",
                        timestamp=ts,
                        prompt_name="greet",
                        arguments={"name": "phase5"},
                        rendered=[
                            {
                                "role": "user",
                                "content": {
                                    "type": "text",
                                    "text": "Please greet phase5.",
                                },
                            },
                            {
                                "role": "assistant",
                                "content": {
                                    "type": "text",
                                    "text": "Hello, phase5!",
                                },
                            },
                        ],
                        **mcp_common,
                        **identity,
                        **common,
                    )
                )
                posted += 1
            else:
                print(
                    f"  warn: unknown mcp_* extras tag {extra!r} for {session_id[:8]}; ignored",
                    file=sys.stderr,
                )
        elif extra.startswith("llm_error_"):
            err_type = extra[len("llm_error_") :]
            # Per-taxonomy http_status / retry_after defaults so the
            # seeded payloads look realistic. Anything not enumerated
            # here falls through to a generic 500 — keeps the seeder
            # tolerant of future taxonomy additions without forcing
            # a config update.
            err_meta = {
                "rate_limit": (429, "anthropic", "rate_limit_exceeded", 30, True),
                "context_overflow": (
                    400,
                    "anthropic",
                    "context_length_exceeded",
                    None,
                    False,
                ),
                "authentication": (401, "openai", "invalid_api_key", None, False),
                "timeout": (None, "openai", None, None, True),
            }.get(err_type, (500, "anthropic", None, None, False))
            http_status, provider, code, retry_after, retryable = err_meta
            post_event(
                make_event(
                    session_id,
                    agent_cfg["flavor"],
                    "llm_error",
                    timestamp=ts,
                    error={
                        "error_type": err_type,
                        "provider": provider,
                        "http_status": http_status,
                        "provider_error_code": code,
                        "error_message": f"E2E seeded {err_type} error",
                        "request_id": f"req_e2e_{err_type}",
                        "retry_after": retry_after,
                        "is_retryable": retryable,
                    },
                    # Operator-actionable retry-chain context. terminal
                    # mirrors !is_retryable so non-retryable taxonomy
                    # entries (authentication, context_overflow) drive
                    # the TERMINAL facet without needing a separate
                    # extras tag.
                    retry_attempt=1,
                    terminal=not retryable,
                    **identity,
                    **common,
                )
            )
            posted += 1
        else:
            print(
                f"  warn: unknown phase4_extras entry {extra!r} for {session_id[:8]}; ignored",
                file=sys.stderr,
            )

    return posted


def _session_is_complete(
    session_id: str,
    role_cfg: dict[str, Any] | None = None,
) -> bool:
    """Return True if the session already has every event the canonical
    timeline expects: the base sequence (>= MIN_EVENTS_FOR_COMPLETE)
    plus one event per ``phase4_extras`` entry, identified by the
    expected event_type signature.

    Without the phase4_extras check, an old seeded session that
    pre-dated the canonical fixture's phase4 expansion would skip the
    re-emit forever — leaving fresh-active sessions without the
    embeddings + streaming events T14/T15 depend on. The phase4 check
    keeps the per-session idempotency tight: if any expected
    event_type is missing, treat the session as incomplete and
    re-seed (additive — duplicates are accepted because the seed
    runs in dev only, tests use .first() selectors).
    """
    try:
        detail = get_session(session_id)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return False
        raise
    events = detail.get("events") or []
    if len(events) < MIN_EVENTS_FOR_COMPLETE:
        return False
    extras: list[str] = list((role_cfg or {}).get("phase4_extras") or [])
    if not extras:
        return True
    # Map each extras tag to the event_type its seed emit would
    # produce. Multiple tags can map to the same event_type
    # (streaming_post_call + streaming_post_call_aborted both emit
    # post_call rows) — counted as separate occurrences so we don't
    # treat a single post_call as covering both.
    expected_counts: dict[str, int] = {}
    for tag in extras:
        if tag in (
            "embeddings",
            "embeddings_with_content_string",
            "embeddings_with_content_list",
        ):
            # All three variants emit event_type=embeddings; the
            # has_content + payload.input shape varies but the
            # event_type identifier is shared. Counting them as
            # one bucket is correct -- a session that has all
            # three needs three embeddings events.
            expected_counts["embeddings"] = expected_counts.get("embeddings", 0) + 1
        elif tag.startswith("llm_error_"):
            expected_counts["llm_error"] = expected_counts.get("llm_error", 0) + 1
        elif tag in (
            "mcp_tool_list",
            "mcp_tool_call",
            "mcp_resource_list",
            "mcp_resource_read",
            "mcp_prompt_list",
            "mcp_prompt_get",
        ):
            # Phase 5: each MCP extras tag maps directly to its own
            # event_type row. Counted independently so a session
            # declaring all six needs six events of distinct types
            # to be considered complete.
            expected_counts[tag] = expected_counts.get(tag, 0) + 1
        elif tag == "mcp_tool_call_failed":
            # Phase 5 D-MCP-FAIL — failed mcp_tool_call. Same event_type
            # as the success variant but disambiguated by payload.error
            # in the actual_counts loop below. Counted under a private
            # synthetic key so the success and failure variants can
            # coexist on the same session without one masking the other.
            expected_counts["__mcp_tool_call_failed__"] = (
                expected_counts.get("__mcp_tool_call_failed__", 0) + 1
            )
        elif tag in ("policy_warn", "policy_degrade", "policy_block"):
            # Each policy_* tag maps directly to its own event_type
            # row. Counted independently so a session declaring all
            # three needs three events of distinct types to be
            # complete.
            expected_counts[tag] = expected_counts.get(tag, 0) + 1
        elif tag in ("streaming_post_call", "streaming_post_call_aborted"):
            # Disambiguate streaming post_call from the base post_call
            # by requiring the streaming sub-object on the payload.
            expected_counts["__streaming_post_call__"] = (
                expected_counts.get("__streaming_post_call__", 0) + 1
            )
    actual_counts: dict[str, int] = {}
    for e in events:
        et = e.get("event_type", "")
        payload = e.get("payload") or {}
        # mcp_tool_call_failed gets counted BEFORE the generic mcp_tool_call
        # bump so a single failure row doesn't double-credit success +
        # failure under one event.
        if et == "mcp_tool_call" and payload.get("error"):
            key = "__mcp_tool_call_failed__"
            actual_counts[key] = actual_counts.get(key, 0) + 1
            continue
        if et in expected_counts:
            actual_counts[et] = actual_counts.get(et, 0) + 1
        if et == "post_call" and payload.get("streaming"):
            key = "__streaming_post_call__"
            actual_counts[key] = actual_counts.get(key, 0) + 1
    for key, want in expected_counts.items():
        if actual_counts.get(key, 0) < want:
            return False
    return True


_VALID_FORCE_STATES = frozenset({"active", "idle", "stale", "lost", "closed"})


def _backdate_session(
    session_id: str,
    started_offset_sec: int,
    ended_offset_sec: int | None,
    force_state: str | None = None,
) -> None:
    """Force started_at / last_seen_at / ended_at to the declared offsets
    via ``docker exec psql``. The worker stamps NOW() for these columns
    on every event write, so the only way to land an "aged" or "stale"
    fixture deterministically is to UPDATE directly after the events
    land.

    Mirrors test_session_states.py:269's pattern. Best-effort — if
    psql isn't reachable or the row isn't there yet, the function logs
    and continues; the test that relies on the backdate will surface
    the gap clearly.

    ``force_state`` overrides the state column explicitly — used for
    aged-closed so a session_end event that raced or missed the FK
    window does not leave the fixture in state='active'. For stale we
    leave the state alone and let the reconciler classify naturally
    based on last_seen_at.

    Phase 4.5 L-17 / L-18 hardening: although every input here comes
    from hardcoded Python literals in canonical.json or int-coerced
    offsets (so the code is unreachable as a SQLi vector in practice),
    we explicitly:
      1. Validate force_state against the closed vocabulary.
      2. Use abs(int(...)) on offsets so a non-int leak from a future
         caller cannot land arbitrary characters.
      3. Validate session_id as UUID format before interpolation.
    The seeder remains f-string driven because ``docker exec psql``
    takes a single -c argument string; switching to psycopg parameter
    binding would require linking psycopg into the seeder which is
    out of scope for a dev fixture.
    """
    if force_state is not None and force_state not in _VALID_FORCE_STATES:
        raise ValueError(
            f"force_state={force_state!r} is not in the closed vocabulary "
            f"{sorted(_VALID_FORCE_STATES)}",
        )
    # Defensive UUID-shape check on the session_id we interpolate.
    try:
        UUID(session_id)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"_backdate_session: session_id {session_id!r} is not a UUID") from exc
    started_secs = abs(int(started_offset_sec))
    started_expr = f"NOW() - INTERVAL '{started_secs} seconds'"
    parts = [
        f"started_at = {started_expr}",
    ]
    if ended_offset_sec is None:
        parts.append(f"last_seen_at = {started_expr}")
    else:
        ended_secs = abs(int(ended_offset_sec))
        parts.append(f"last_seen_at = NOW() - INTERVAL '{ended_secs} seconds'")
        parts.append(f"ended_at = NOW() - INTERVAL '{ended_secs} seconds'")
    if force_state is not None:
        # force_state passed the whitelist above so direct interpolation
        # is safe at this point. (Belt-and-braces.)
        parts.append(f"state = '{force_state}'")
    set_clause = ", ".join(parts)
    sql = f"UPDATE sessions SET {set_clause} WHERE session_id = '{session_id}'::uuid"
    try:
        result = subprocess.run(
            [
                "docker",
                "exec",
                "docker-postgres-1",
                "psql",
                "-U",
                "flightdeck",
                "-d",
                "flightdeck",
                "-c",
                sql,
            ],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode != 0:
            print(
                f"  warn: psql backdate for {session_id} returned "
                f"{result.returncode}: {result.stderr.strip()}",
                file=sys.stderr,
            )
    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
        print(
            f"  warn: psql backdate for {session_id} failed: {exc}",
            file=sys.stderr,
        )


def _wait_for_fleet_visibility(expected_agent_names: list[str], timeout: float) -> None:
    """Poll GET /v1/fleet until every expected agent_name is present.

    The fleet endpoint is what Playwright tests land on, so this is the
    correct success signal — not the per-session detail endpoint.
    """
    import urllib.request

    # ``per_page=200`` is the server's hard cap (see api/internal/
    # handlers/fleet.go). The seeder polls one page; under realistic
    # dev DB pollution (this repo's local dev sees 130+ accumulated
    # ``e2e-*`` agents from prior test runs) the canonical fixtures
    # can fall off page 1 with the default 50, hanging the seeder
    # waiting for an agent that's actually present but on page 2+.
    # 200 fits any realistic dev fleet; if the dev DB ever exceeds
    # 200 agents the seed should iterate pages, but that's a future
    # concern.
    deadline = time.time() + timeout
    missing: list[str] = list(expected_agent_names)
    while time.time() < deadline:
        req = urllib.request.Request(
            f"{API_URL}/v1/fleet?per_page=200",
            headers=auth_headers(),
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            payload = json.loads(resp.read())
        live_names = {a.get("agent_name", "") for a in (payload.get("agents") or [])}
        missing = [n for n in expected_agent_names if n not in live_names]
        if not missing:
            return
        time.sleep(1.0)
    raise TimeoutError(
        f"Fleet did not surface all E2E fixtures after {timeout}s. "
        f"Missing: {missing}. Check workers logs."
    )


def seed(mode: str = "full") -> None:
    """Seed canonical E2E fixtures.

    ``mode="full"`` (default): seed sessions that aren't already complete,
    wait for fleet visibility, then run the active-role refresh + backdate
    pass. The Playwright globalSetup invokes this once at job start.

    ``mode="active-only"``: skip the initial-seed loop, the fleet-visibility
    wait, AND the closed/aged/stale backdating. Run ONLY the active-role
    refresh path (fresh-active / error-active / mcp-active / policy-active).
    Used by the Playwright globalSetup keep-alive watchdog so the workers'
    reconciler (postgres.go:651, 60-second tick, 2-min stale threshold)
    cannot age the seeded "fresh"-class fixtures past ``state='active'``
    while the test suite runs. D126 added 13 E2E specs (T28–T40) that
    push the suite past 5 minutes — well beyond the original 2-min
    seed-to-test-completion window the no-keep-alive design assumed.
    """
    print(f"[seed] waiting for services at {INGESTION_URL} / {API_URL} ...")
    wait_for_services(timeout=30)

    with CANONICAL_PATH.open() as fh:
        cfg = json.load(fh)

    roles_cfg: dict[str, dict[str, Any]] = cfg["session_roles"]
    agents_cfg: list[dict[str, Any]] = cfg["agents"]

    total_sessions = sum(len(a["session_roles"]) for a in agents_cfg)
    print(f"[seed] canonical dataset: {len(agents_cfg)} agents, {total_sessions} sessions")

    seeded: int = 0
    skipped: int = 0
    backdated: int = 0

    if mode == "full":
        for agent_cfg in agents_cfg:
            for role in agent_cfg["session_roles"]:
                role_cfg = roles_cfg[role]
                session_id = _derive_session_id(agent_cfg["agent_name"], role)

                if _session_is_complete(session_id, role_cfg):
                    print(
                        f"  skip {agent_cfg['agent_name']}/{role} ({session_id[:8]}) — already has events"
                    )
                    skipped += 1
                    continue

                posted = _post_session_events(
                    agent_cfg=agent_cfg,
                    session_id=session_id,
                    role_cfg=role_cfg,
                )
                seeded += 1
                print(
                    f"  seeded {agent_cfg['agent_name']}/{role} ({session_id[:8]}) — {posted} events"
                )

        expected_agent_names = [a["agent_name"] for a in agents_cfg]
        print(f"[seed] waiting for worker to persist {len(expected_agent_names)} agents ...")
        _wait_for_fleet_visibility(expected_agent_names, timeout=SEED_READY_TIMEOUT_SEC)

    # Backdate aged-closed / stale sessions so their visible timestamps
    # match the declared offsets. Done AFTER the fleet-visibility wait
    # so the worker has finished stamping NOW() on every column before
    # we move them. aged-closed also gets an explicit state='closed'
    # override because a session_end that races the session_start
    # insert leaves the row in state='active'; the UI renders state by
    # the enum, not by presence of ended_at.
    #
    # fresh-active is *forward-dated* on every seed run (not skipped by
    # idempotency) because wall-clock time between seed and
    # Playwright run drifts last_seen_at into the reconciler's 2-min
    # stale window. The session_id is stable (uuid5-derived) so
    # re-stamping last_seen_at = NOW() and pinning state='active'
    # keeps the fixture semantics consistent without re-emitting
    # events. Matches the aged-closed/stale pattern: the UI reads
    # state enum + last_seen_at, not the event stream's recency.
    for agent_cfg in agents_cfg:
        for role in agent_cfg["session_roles"]:
            role_cfg = roles_cfg[role]
            session_id = _derive_session_id(agent_cfg["agent_name"], role)
            if role in ("fresh-active", "error-active"):
                # Pin state='active' and last_seen_at to NOW. Runs on
                # every seed invocation so the session stays fresh
                # relative to the Playwright run even if the previous
                # seed landed 10 min ago. ``error-active`` shares this
                # path so its 4 llm_error events + aborted stream
                # remain visible alongside an ``active`` state badge
                # — T15's aborted scene and T16's filter-then-click
                # path both rely on the role being state=active.
                #
                # ALSO emit a fresh tool_call event (timestamp=NOW-5s)
                # on every seed run. Without this, the event stream's
                # newest timestamp stays frozen at original-seed-time;
                # the Fleet swimlane defaults to a 1-minute domain,
                # so events older than 60s are filtered out at render
                # time (timeline/SwimLane.tsx AggregatedSessionEvents
                # line 655). The refresh keeps a visible circle in the
                # swimlane regardless of how much wall-clock time
                # passed between seeds.
                sql = (
                    f"UPDATE sessions SET "
                    f"state='active', "
                    f"last_seen_at=NOW(), "
                    f"started_at=NOW() - INTERVAL '30 seconds' "
                    f"WHERE session_id='{session_id}'::uuid"
                )
                try:
                    subprocess.run(
                        [
                            "docker",
                            "exec",
                            "docker-postgres-1",
                            "psql",
                            "-U",
                            "flightdeck",
                            "-d",
                            "flightdeck",
                            "-c",
                            sql,
                        ],
                        capture_output=True,
                        text=True,
                        timeout=10,
                        check=False,
                    )
                    # Emit a fresh tool_call so the session has an
                    # in-window event for the default 1m swimlane
                    # domain. Skipped in active-only (keep-alive)
                    # mode — the watchdog runs every 30 sec during
                    # the test suite and a steady stream of fresh
                    # events perturbs swimlane-scroll-position
                    # tests like T24 (the rendering rightmost-edge
                    # auto-follow recomputes on each new circle).
                    # The reconciler-defeating purpose of the
                    # watchdog is satisfied entirely by the SQL pin
                    # above; the swimlane-window concern only
                    # matters once at seed time, not every 30 sec.
                    identity = {
                        "agent_type": agent_cfg["agent_type"],
                        "client_type": agent_cfg["client_type"],
                        "user": agent_cfg["user"],
                        "hostname": agent_cfg["hostname"],
                        "agent_name": agent_cfg["agent_name"],
                    }
                    if mode == "active-only":
                        backdated += 1
                        continue
                    post_event(
                        make_event(
                            session_id,
                            agent_cfg["flavor"],
                            "tool_call",
                            timestamp=_shift_timestamp(-5),
                            tool_name="e2e_refresh",
                            tool_input={"reason": "seed keeps fresh-active in 1m swimlane window"},
                            tool_result={"ok": True},
                            framework=agent_cfg["framework"],
                            model=agent_cfg["model"],
                            host=agent_cfg["host"],
                            **identity,
                        )
                    )
                    backdated += 1
                except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
                    print(
                        f"  warn: fresh-active refresh for {session_id} failed: {exc}",
                        file=sys.stderr,
                    )
                continue
            if role == "mcp-active":
                # Phase 5 (B-5b live verification) — re-emit the six
                # MCP_* events with timestamp=NOW each seed run so the
                # Fleet swimlane window (max 1h) always carries fresh
                # MCP traffic for the Supervisor's Chrome walkthrough
                # AND for T25-13's hexagon assertion. The session_start
                # path is gated by the standard idempotency check
                # (already-seeded sessions are skipped) which keeps
                # the context.mcp_servers fingerprint write-once.
                # Re-emitting the extras only — not the session_start —
                # avoids touching the worker's UpsertSession ON
                # CONFLICT path on every run.
                identity = {
                    "agent_type": agent_cfg["agent_type"],
                    "client_type": agent_cfg["client_type"],
                    "user": agent_cfg["user"],
                    "hostname": agent_cfg["hostname"],
                    "agent_name": agent_cfg["agent_name"],
                }
                common = {
                    "host": agent_cfg["host"],
                    "framework": agent_cfg["framework"],
                    "model": agent_cfg["model"],
                }
                servers = role_cfg.get("mcp_servers") or []
                if servers:
                    srv = servers[0]
                    srv_name = srv["name"]
                    srv_transport = srv["transport"]
                    # Pin state='active' + last_seen_at=NOW so the
                    # session row reads as live alongside the fresh
                    # event circles.
                    sql = (
                        f"UPDATE sessions SET "
                        f"state='active', "
                        f"last_seen_at=NOW() "
                        f"WHERE session_id='{session_id}'::uuid"
                    )
                    try:
                        subprocess.run(
                            [
                                "docker",
                                "exec",
                                "docker-postgres-1",
                                "psql",
                                "-U",
                                "flightdeck",
                                "-d",
                                "flightdeck",
                                "-c",
                                sql,
                            ],
                            capture_output=True,
                            text=True,
                            timeout=10,
                            check=False,
                        )
                    except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
                        print(
                            f"  warn: mcp-active state pin for {session_id} failed: {exc}",
                            file=sys.stderr,
                        )
                    # Mirror the original extras emit shape from
                    # _post_session_events. Each MCP event lands a
                    # few seconds apart so the swimlane shows them
                    # as a small cluster rather than overlapping.
                    fresh_emits: list[tuple[str, dict[str, Any]]] = [
                        ("mcp_tool_list", {"count": 3}),
                        (
                            "mcp_tool_call",
                            {
                                "tool_name": "echo",
                                "arguments": {"text": "phase5-fixture"},
                                "result": {
                                    "content": [
                                        {"type": "text", "text": "phase5-fixture"},
                                    ],
                                    "isError": False,
                                },
                            },
                        ),
                        ("mcp_resource_list", {"count": 1}),
                        (
                            "mcp_resource_read",
                            {
                                "resource_uri": "mem://demo",
                                "content_bytes": 46,
                                "mime_type": "text/plain",
                                "content": {
                                    "contents": [
                                        {
                                            "uri": "mem://demo",
                                            "mimeType": "text/plain",
                                            "text": (
                                                "hello from the flightdeck reference MCP server"
                                            ),
                                        },
                                    ],
                                },
                            },
                        ),
                        ("mcp_prompt_list", {"count": 1}),
                        (
                            "mcp_prompt_get",
                            {
                                "prompt_name": "greet",
                                "arguments": {"name": "phase5"},
                                "rendered": [
                                    {
                                        "role": "user",
                                        "content": {
                                            "type": "text",
                                            "text": "Please greet phase5.",
                                        },
                                    },
                                    {
                                        "role": "assistant",
                                        "content": {
                                            "type": "text",
                                            "text": "Hello, phase5!",
                                        },
                                    },
                                ],
                            },
                        ),
                    ]
                    for j, (event_type, extras) in enumerate(fresh_emits):
                        # ts placement: each event lands at NOW - (50 -
                        # 8*j) seconds, so the cluster spans roughly
                        # NOW-50s through NOW-10s. The 8s-per-step
                        # spread keeps the six circles distinguishable
                        # in the swimlane. The 50s upper bound leaves
                        # comfortable margin under the 1m (60s) Fleet
                        # swimlane default — even after a few seconds
                        # of seed propagation latency, every event
                        # stays inside the window.
                        ts = _shift_timestamp(-(50 - 8 * j))
                        post_event(
                            make_event(
                                session_id,
                                agent_cfg["flavor"],
                                event_type,
                                timestamp=ts,
                                server_name=srv_name,
                                transport=srv_transport,
                                duration_ms=18 + 4 * j,
                                **extras,
                                **identity,
                                **common,
                            )
                        )

                    # B-6 — one fresh ``mcp_resource_read`` with an
                    # overflowed body so live verification of the
                    # "Load full response" affordance has data to
                    # exercise. The wire shape mirrors what the
                    # sensor's overflow path produces:
                    # has_content=true and ``content`` carrying the
                    # event_content dict (provider/model/response).
                    # The worker's existing has_content=true branch
                    # then writes an event_content row. Time-stamped
                    # at NOW-2s so it sits at the cluster edge.
                    big_text = "x" * (12 * 1024)  # 12 KiB body
                    overflow_event_content = {
                        "system": None,
                        "messages": [],
                        "tools": None,
                        "response": {
                            "contents": [
                                {
                                    "uri": "mem://big-log",
                                    "mimeType": "text/plain",
                                    "text": big_text,
                                },
                            ],
                        },
                        "input": None,
                        "provider": "mcp",
                        "model": srv_name,
                        "session_id": session_id,
                        "event_id": "",
                        "captured_at": (
                            datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
                        ),
                    }
                    post_event(
                        make_event(
                            session_id,
                            agent_cfg["flavor"],
                            "mcp_resource_read",
                            timestamp=_shift_timestamp(-2),
                            server_name=srv_name,
                            transport=srv_transport,
                            resource_uri="mem://big-log",
                            content_bytes=len(big_text),
                            mime_type="text/plain",
                            duration_ms=42,
                            has_content=True,
                            content=overflow_event_content,
                            **identity,
                            **common,
                        )
                    )
                    backdated += 1
                continue
            if role == "policy-active":
                # Re-emit the three policy enforcement events with
                # timestamp=NOW each seed run so the Fleet sidebar's
                # POLICY EVENTS panel always has live-window-fresh
                # data to render. Without this, the
                # ``_session_is_complete`` idempotency check skips
                # re-emission on subsequent seed runs and the
                # canonical events age out of every Fleet time-range
                # button (max 1h) within hours of the first seed.
                #
                # Parallel rationale to ``mcp-active`` above (Phase 5
                # B-5b live verification): the fixture role exists to
                # anchor a UI surface whose data must stay fresh
                # across seed runs. Re-emitting the extras only — not
                # session_start — keeps the worker's UpsertSession ON
                # CONFLICT path untouched on repeat runs.
                #
                # T17 (Investigate POLICY facet, drawer detail
                # strings, severity-ranked dot) reads only event_type
                # + payload shape, both of which match the first-seed
                # payload at lines 362–393 verbatim, so re-emission
                # is contract-equivalent and T17 cannot regress.
                identity = {
                    "agent_type": agent_cfg["agent_type"],
                    "client_type": agent_cfg["client_type"],
                    "user": agent_cfg["user"],
                    "hostname": agent_cfg["hostname"],
                    "agent_name": agent_cfg["agent_name"],
                }
                common = {
                    "host": agent_cfg["host"],
                    "framework": agent_cfg["framework"],
                    "model": agent_cfg["model"],
                }
                # Pin state='active' + last_seen_at=NOW so the session
                # row reads as live alongside the fresh enforcement
                # event circles. Same docker-exec psql pattern
                # fresh-active and mcp-active use.
                sql = (
                    f"UPDATE sessions SET "
                    f"state='active', "
                    f"last_seen_at=NOW() "
                    f"WHERE session_id='{session_id}'::uuid"
                )
                try:
                    subprocess.run(
                        [
                            "docker",
                            "exec",
                            "docker-postgres-1",
                            "psql",
                            "-U",
                            "flightdeck",
                            "-d",
                            "flightdeck",
                            "-c",
                            sql,
                        ],
                        capture_output=True,
                        text=True,
                        timeout=10,
                        check=False,
                    )
                except (subprocess.TimeoutExpired, FileNotFoundError) as exc:
                    print(
                        f"  warn: policy-active state pin for {session_id} failed: {exc}",
                        file=sys.stderr,
                    )
                # Three enforcement event types, payload shape mirrors
                # the first-seed branch in _post_session_events at
                # lines 362–393. Each event lands a few seconds apart
                # so the swimlane shows them as a small cluster
                # rather than overlapping. NOW-30s / -20s / -10s
                # leaves comfortable margin under the 1m Fleet
                # swimlane domain AND 5+ minute margin for the Rule
                # 40c.1 twice-in-a-row run under the spec's 1h
                # time-range click.
                fresh_policy_emits: list[tuple[str, dict[str, Any]]] = [
                    (
                        "policy_warn",
                        {
                            "source": "server",
                            "threshold_pct": 80,
                            "tokens_used": 8000,
                            "token_limit": 10000,
                        },
                    ),
                    (
                        "policy_degrade",
                        {
                            "source": "server",
                            "threshold_pct": 90,
                            "tokens_used": 9100,
                            "token_limit": 10000,
                            "from_model": "claude-sonnet-4-6",
                            "to_model": "claude-haiku-4-5",
                        },
                    ),
                    (
                        "policy_block",
                        {
                            "source": "server",
                            "threshold_pct": 100,
                            "tokens_used": 10100,
                            "token_limit": 10000,
                            "intended_model": "claude-opus-4-7",
                        },
                    ),
                ]
                for j, (event_type, payload) in enumerate(fresh_policy_emits):
                    ts = _shift_timestamp(-(30 - 10 * j))  # -30, -20, -10
                    post_event(
                        make_event(
                            session_id,
                            agent_cfg["flavor"],
                            event_type,
                            timestamp=ts,
                            **payload,
                            **identity,
                            **common,
                        )
                    )
                backdated += 1
                continue
            # In active-only mode the keep-alive watchdog only refreshes
            # active fixtures — closed/aged/stale rows are write-once at
            # initial seed and don't drift, so re-running the backdate
            # path on every tick is wasted work and could race with
            # tests asserting on those rows.
            if mode != "full":
                continue
            # D126 § 7.fix step 8 — generic ``force_state`` opt-in.
            # Any role that declares ``force_state`` in canonical.json
            # gets a backdate with that state, regardless of whether
            # it's one of the legacy aged-closed / stale / ancient-only
            # paths. T40 (L8 fixture, subagent-error → lost) drives
            # this branch; older fixtures still go through the explicit
            # match below.
            explicit_force = role_cfg.get("force_state")
            if explicit_force is None and role not in (
                "aged-closed",
                "stale",
                "ancient-only",
            ):
                continue
            # Force state for deterministic E2E assertions. Letting the
            # reconciler reclassify naturally would flake: the
            # reconciler runs on a timer (see workers postgres.go:543),
            # so test runs that start right after seed may catch
            # aged-closed/stale in state='active' briefly. Tests assert
            # on the UI behaviour per state, so pinning the enum is
            # fine and matches how test_session_states.py:54 handles
            # the same class of fixture.
            if explicit_force is not None:
                forced_state = explicit_force
            elif role == "aged-closed":
                forced_state = "closed"
            elif role == "stale":
                # 3h past last_seen_at is well beyond the 10-min lost
                # threshold. 'lost' is what the reconciler would set on
                # its next pass anyway; pinning it up-front makes the
                # fixture test-stable on a freshly-seeded stack.
                forced_state = "lost"
            elif role == "ancient-only":
                # T5b anchor (V-DRAWER fix): session > 7 days old, the
                # window the API's pre-fix default would have hidden.
                # Forced to 'closed' so the swimlane row reads cleanly
                # (the session_end at -8 days actually emits, but the
                # reconciler hasn't pinned the state yet on a freshly-
                # seeded stack).
                forced_state = "closed"
            else:
                forced_state = None
            _backdate_session(
                session_id=session_id,
                started_offset_sec=int(role_cfg["started_offset_sec"]),
                ended_offset_sec=role_cfg["ended_offset_sec"],
                force_state=forced_state,
            )
            backdated += 1

    print(f"[seed] done — seeded={seeded} skipped={skipped} backdated={backdated}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description=(
            "Seed canonical E2E fixtures. Default mode does the full "
            "seed + active-refresh + backdate pass. ``--reseed-active-"
            "only`` runs only the active-role refresh — used by the "
            "Playwright globalSetup keep-alive watchdog so the workers "
            "reconciler doesn't age fresh-class fixtures past "
            "state='active' during long test runs."
        ),
    )
    parser.add_argument(
        "--reseed-active-only",
        action="store_true",
        help=(
            "Skip initial seeding, fleet-visibility wait, and "
            "closed/aged/stale backdating. Refresh only the four "
            "active roles (fresh-active, error-active, mcp-active, "
            "policy-active). Idempotent and safe to call repeatedly."
        ),
    )
    args = parser.parse_args()
    mode = "active-only" if args.reseed_active_only else "full"
    try:
        seed(mode=mode)
    except Exception as exc:
        print(f"[seed] FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
