#!/usr/bin/env python3
"""Seed an invented fleet into a throwaway Flightdeck, for screenshots.

The images in the README are taken from a ``flightdeck`` started on an
empty data dir and filled by this script; ``scripts/readme_images.mjs``
takes them and its header has the whole procedure:

    FLIGHTDECK_RATE_LIMIT_PER_MINUTE=100000 flightdeck \
        --listen 127.0.0.1:4610 --data-dir "$(mktemp -d)"
    python3 scripts/demo_seed.py --server http://127.0.0.1:4610

The rate limit is raised because the history is about 2,100 events
posted in a few seconds, and ingestion allows a token 1,000 a minute.

Everything here is invented: the agents, hosts, users, tools and MCP
servers name nothing real, no prompt or response text is sent (every
session has capture off), no model is called and no API key is read.
The script uses the standard library only and posts through the same
ingestion API a sensor does, with the development token a loopback
``flightdeck`` accepts.

The events are the same on every run (a fixed random seed); only their
timestamps move, since they are offsets from now. History covers the
last 46 hours, because ingestion refuses an event older than 48 hours;
the runs that are left open have their newest events inside the fleet
view's live window. ``--live SECONDS`` then keeps those runs emitting in
real time, which is what a recording of the fleet view shows.

The workers stamp a session's start and end with the time they store
it, not the event's own time, so every run of the history starts and
ends at seeding time as far as the dashboard's run lists and the fleet
view's run markers are concerned: only the events are spread over the
46 hours. Take pictures of the fleet view a minute or more after
seeding, when those markers have left its one-minute window.

It refuses a server on port 4000 unless ``--allow-default-port`` is
given: that port is where a Flightdeck with real data usually listens,
and this script is for an instance that will be thrown away. For the
same reason it refuses a server that is not on this machine unless
``--allow-remote`` is given, and it takes no server from the
environment: ``--server`` is required.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid5

# The namespace the sensor and the plugin derive agent ids in
# (sensor/flightdeck_sensor/core/agent_id.py); ingestion requires the
# agent_id a real client would have sent.
NAMESPACE_FLIGHTDECK = UUID("ee22ab58-26fc-54ef-91b4-b5c0a97f9b61")

# The token a `flightdeck` bound to loopback accepts.
DEV_TOKEN = "tok_dev"

# The port a Flightdeck with real data usually listens on.
DEFAULT_PORT = 4000

# The one host name that is this machine; an address is this machine
# when it is a loopback address. Anything else is someone's server.
LOOPBACK_NAME = "localhost"

# The sensor version stamped on session_start, which ingestion requires.
SENSOR_VERSION = "0.8.0"

# The seed of every random choice, so two runs post the same events.
RANDOM_SEED = 20261112

# How far back the history goes. Ingestion refuses an event older than
# 48 hours; two hours of margin cover a slow seed and clock skew.
HISTORY_HOURS = 46

# How long a request may take, and how long a new session may take to
# be readable before its other events are posted (the workers store a
# session's first event before any event that refers to it).
REQUEST_TIMEOUT_SECS = 10
SESSION_VISIBLE_TIMEOUT_SECS = 15

# The open runs: when each started and where its newest event sits, in
# seconds before now. The newest events must fall inside the fleet
# view's default one-minute window to be on screen.
LIVE_RUN_STARTED_SECS = 55
LIVE_RUN_NEWEST_EVENT_SECS = 3

# --live: the pause between two rounds, and the share of the open runs
# that make a model call (and often a tool call) in each. A quarter of
# nine runs every 1.5 seconds keeps every row of the fleet view moving
# without burying it in events.
LIVE_ROUND_SECS = 1.5
LIVE_ROUND_SHARE = 4

# --live: the researcher's denied MCP call recurs every this many
# rounds (21 seconds), starting with the first, so its timeline always
# has a blocked call a few events from the top, which is where the
# README's third tile looks for one.
LIVE_BLOCK_EVERY_ROUNDS = 14

# The variable that raises ingestion's per-token rate limit, named in
# the message a refused event prints.
RATE_LIMIT_VARIABLE = "FLIGHTDECK_RATE_LIMIT_PER_MINUTE"


@dataclass(frozen=True)
class McpServer:
    name: str
    transport: str
    url: str
    tools: tuple[str, ...]


@dataclass
class Agent:
    """One row of the fleet: who it is and the shape of its traffic."""

    name: str
    agent_type: str  # production | coding
    client_type: str  # flightdeck_sensor | claude_code
    user: str
    hostname: str
    framework: str | None
    provider: str
    model: str
    billing_mode: str  # metered | subscription
    tools: tuple[str, ...]
    tokens_in: tuple[int, int]
    tokens_out: tuple[int, int]
    latency_ms: tuple[int, int]
    runs_per_day: int  # closed runs per day of history
    calls_per_run: tuple[int, int]
    mcp: McpServer | None = None
    flavor: str = ""
    role: str | None = None  # set on a sub-agent
    parent: Agent | None = None
    token_limit: int | None = None

    def __post_init__(self) -> None:
        if not self.flavor:
            self.flavor = self.name

    @property
    def agent_id(self) -> str:
        path = (
            f"flightdeck://{self.agent_type}/{self.user}@{self.hostname}"
            f"/{self.client_type}/{self.name}"
        )
        if self.role:
            path = f"{path}/{self.role}"
        return str(uuid5(NAMESPACE_FLIGHTDECK, path))

    def session_id(self, tag: str) -> str:
        return str(uuid5(NAMESPACE_FLIGHTDECK, f"demo-seed/{self.name}/{self.role}/{tag}"))


HELPDESK = McpServer(
    "helpdesk",
    "http",
    "https://mcp.helpdesk.example/sse",
    ("search_tickets", "get_ticket", "add_note"),
)
WAREHOUSE = McpServer(
    "warehouse", "http", "https://mcp.warehouse.example/mcp", ("run_query", "describe_table")
)
WEB_SEARCH = McpServer(
    "web-search", "http", "https://mcp.search.example/sse", ("search", "fetch_page")
)
SCRATCH_FS = McpServer("scratch-fs", "stdio", "npx -y scratch-fs-mcp /tmp", ("write_file",))
REPO_TOOLS = McpServer(
    "repo-tools", "stdio", "uvx repo-tools-mcp", ("list_pull_requests", "get_diff")
)

SUPPORT = Agent(
    name="support-triage",
    agent_type="production",
    client_type="flightdeck_sensor",
    user="svc-agents",
    hostname="prod-agents-1",
    framework="langchain",
    provider="anthropic",
    model="claude-haiku-4-5",
    billing_mode="metered",
    tools=("classify_ticket", "lookup_customer", "draft_reply"),
    tokens_in=(900, 2600),
    tokens_out=(120, 480),
    latency_ms=(450, 1400),
    runs_per_day=9,
    calls_per_run=(6, 14),
    mcp=HELPDESK,
    token_limit=400_000,
)
CODE_REVIEW = Agent(
    name="code-review",
    agent_type="production",
    client_type="flightdeck_sensor",
    user="ci",
    hostname="ci-runner-3",
    framework="langgraph",
    provider="anthropic",
    model="claude-sonnet-4-6",
    billing_mode="metered",
    tools=("read_file", "run_linter", "post_comment"),
    tokens_in=(4200, 16000),
    tokens_out=(500, 2200),
    latency_ms=(2200, 7800),
    runs_per_day=5,
    calls_per_run=(4, 9),
    mcp=REPO_TOOLS,
)
INVOICES = Agent(
    name="invoice-extractor",
    agent_type="production",
    client_type="flightdeck_sensor",
    user="svc-agents",
    hostname="prod-agents-2",
    framework=None,
    provider="openai",
    model="gpt-4o-mini",
    billing_mode="metered",
    tools=("parse_pdf", "validate_totals", "store_invoice"),
    tokens_in=(1800, 5200),
    tokens_out=(300, 900),
    latency_ms=(600, 2100),
    runs_per_day=12,
    calls_per_run=(3, 7),
)
RESEARCH = Agent(
    name="research-assistant",
    agent_type="production",
    client_type="flightdeck_sensor",
    user="svc-agents",
    hostname="prod-agents-1",
    framework="crewai",
    provider="openai",
    model="gpt-5",
    billing_mode="metered",
    tools=("plan_research", "summarize"),
    tokens_in=(2500, 9000),
    tokens_out=(600, 2600),
    latency_ms=(1800, 6400),
    runs_per_day=3,
    calls_per_run=(3, 6),
)
RESEARCHER = Agent(
    name="research-assistant",
    agent_type="production",
    client_type="flightdeck_sensor",
    user="svc-agents",
    hostname="prod-agents-1",
    framework="crewai",
    provider="openai",
    model="gpt-5-mini",
    billing_mode="metered",
    tools=("extract_facts",),
    tokens_in=(3000, 12000),
    tokens_out=(400, 1500),
    latency_ms=(1200, 4200),
    runs_per_day=3,
    calls_per_run=(4, 8),
    mcp=WEB_SEARCH,
    role="Researcher",
    parent=RESEARCH,
)
WRITER = Agent(
    name="research-assistant",
    agent_type="production",
    client_type="flightdeck_sensor",
    user="svc-agents",
    hostname="prod-agents-1",
    framework="crewai",
    provider="anthropic",
    model="claude-sonnet-4-6",
    billing_mode="metered",
    tools=("outline", "cite_sources"),
    tokens_in=(5000, 14000),
    tokens_out=(1200, 3800),
    latency_ms=(3000, 9000),
    runs_per_day=3,
    calls_per_run=(2, 4),
    role="Writer",
    parent=RESEARCH,
)
SQL_ANALYST = Agent(
    name="sql-analyst",
    agent_type="production",
    client_type="flightdeck_sensor",
    user="svc-agents",
    hostname="prod-agents-2",
    framework="llamaindex",
    provider="openai",
    model="gpt-4.1",
    billing_mode="metered",
    tools=("explain_plan", "chart"),
    tokens_in=(3500, 11000),
    tokens_out=(400, 1600),
    latency_ms=(1500, 5200),
    runs_per_day=4,
    calls_per_run=(4, 8),
    mcp=WAREHOUSE,
    token_limit=250_000,
)
CLAUDE_CODE = Agent(
    name="alex@dev-laptop",
    agent_type="coding",
    client_type="claude_code",
    user="alex",
    hostname="dev-laptop",
    framework="claude-code",
    provider="anthropic",
    model="claude-opus-4-7",
    billing_mode="subscription",
    tools=("Read", "Edit", "Bash", "Grep"),
    tokens_in=(8000, 42000),
    tokens_out=(300, 2400),
    latency_ms=(2500, 11000),
    runs_per_day=2,
    calls_per_run=(8, 16),
    flavor="claude-code",
)
CC_EXPLORE = Agent(
    name="alex@dev-laptop",
    agent_type="coding",
    client_type="claude_code",
    user="alex",
    hostname="dev-laptop",
    framework="claude-code",
    provider="anthropic",
    model="claude-haiku-4-5",
    billing_mode="subscription",
    tools=("Grep", "Glob", "Read"),
    tokens_in=(3000, 16000),
    tokens_out=(200, 900),
    latency_ms=(700, 2600),
    runs_per_day=2,
    calls_per_run=(4, 9),
    flavor="claude-code",
    role="Explore",
    parent=CLAUDE_CODE,
)
CC_REVIEWER = Agent(
    name="alex@dev-laptop",
    agent_type="coding",
    client_type="claude_code",
    user="alex",
    hostname="dev-laptop",
    framework="claude-code",
    provider="anthropic",
    model="claude-sonnet-4-6",
    billing_mode="subscription",
    tools=("Read", "Bash"),
    tokens_in=(6000, 22000),
    tokens_out=(500, 2000),
    latency_ms=(1800, 6500),
    runs_per_day=2,
    calls_per_run=(3, 6),
    flavor="claude-code",
    role="code-reviewer",
    parent=CLAUDE_CODE,
)
ONBOARDING = Agent(
    name="onboarding-bot",
    agent_type="production",
    client_type="flightdeck_sensor",
    user="svc-agents",
    hostname="prod-agents-2",
    framework="openai-agents",
    provider="openai",
    model="gpt-5-mini",
    billing_mode="metered",
    tools=("create_account", "send_welcome", "schedule_call"),
    tokens_in=(700, 2400),
    tokens_out=(150, 700),
    latency_ms=(500, 1900),
    runs_per_day=7,
    calls_per_run=(3, 8),
)

# Document order is the order sessions are created in: a parent before
# its sub-agents.
FLEET = [
    SUPPORT,
    CODE_REVIEW,
    INVOICES,
    RESEARCH,
    RESEARCHER,
    WRITER,
    SQL_ANALYST,
    CLAUDE_CODE,
    CC_EXPLORE,
    CC_REVIEWER,
    ONBOARDING,
]

# The agents whose newest run is left open, so the fleet view shows
# them active. The others' runs are all closed.
LIVE = [
    SUPPORT,
    CODE_REVIEW,
    INVOICES,
    RESEARCH,
    RESEARCHER,
    WRITER,
    CLAUDE_CODE,
    CC_EXPLORE,
    CC_REVIEWER,
]


class Client:
    """Posts events and creates policies on one Flightdeck."""

    def __init__(self, server: str, token: str) -> None:
        self.server = server.rstrip("/")
        self.token = token
        self.posted = 0

    def _request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        data = None if body is None else json.dumps(body).encode()
        headers = {"Authorization": f"Bearer {self.token}"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(
            f"{self.server}{path}", data=data, headers=headers, method=method
        )
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECS) as resp:
            raw = resp.read()
        return json.loads(raw) if raw else None

    def event(self, payload: dict[str, Any]) -> None:
        try:
            self._request("POST", "/ingest/v1/events", payload)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")
            hint = ""
            if exc.code == 429:
                hint = f"; start the throwaway flightdeck with {RATE_LIMIT_VARIABLE}=100000"
            raise SystemExit(
                f"demo-seed: ingestion refused a {payload['event_type']} event "
                f"({exc.code}): {detail.strip()}{hint}"
            ) from exc
        self.posted += 1

    def wait_for_session(self, session_id: str) -> None:
        deadline = time.monotonic() + SESSION_VISIBLE_TIMEOUT_SECS
        while time.monotonic() < deadline:
            try:
                self._request("GET", f"/api/v1/sessions/{session_id}")
                return
            except urllib.error.HTTPError as exc:
                if exc.code != 404:
                    raise
            time.sleep(0.05)
        raise SystemExit(
            f"demo-seed: session {session_id} was not stored "
            f"within {SESSION_VISIBLE_TIMEOUT_SECS} s"
        )

    def policy(self, flavor: str, token_limit: int) -> None:
        self._request(
            "POST",
            "/api/v1/policies",
            {
                "scope": "flavor",
                "scope_value": flavor,
                "token_limit": token_limit,
                "warn_at_pct": 80,
                "degrade_at_pct": None,
                "degrade_to": None,
                "block_at_pct": 100,
            },
        )

    def mcp_policy(self, flavor: str, entries: list[dict[str, str]]) -> None:
        self._request(
            "POST",
            f"/api/v1/mcp-policies/{urllib.parse.quote(flavor)}",
            {
                "block_on_uncertainty": False,
                "entries": entries,
            },
        )


def stamp(at: float) -> str:
    moment = datetime.fromtimestamp(at, UTC)
    return moment.strftime("%Y-%m-%dT%H:%M:%S.") + f"{moment.microsecond // 1000:03d}Z"


class Run:
    """One session of one agent: builds its events and posts them."""

    def __init__(
        self, client: Client, agent: Agent, tag: str, rng: random.Random, parent: Run | None = None
    ) -> None:
        self.client = client
        self.agent = agent
        self.rng = rng
        self.session_id = agent.session_id(tag)
        self.parent = parent
        self.tokens_used = 0
        self.warned = False

    def _event(self, event_type: str, at: float, **fields: Any) -> None:
        agent = self.agent
        payload: dict[str, Any] = {
            "session_id": self.session_id,
            "flavor": agent.flavor,
            "event_type": event_type,
            "agent_id": agent.agent_id,
            "agent_type": agent.agent_type,
            "agent_name": agent.name,
            "client_type": agent.client_type,
            "user": agent.user,
            "hostname": agent.hostname,
            "host": agent.hostname,
            "framework": agent.framework,
            "model": None,
            "tokens_input": None,
            "tokens_output": None,
            "tokens_total": None,
            "tokens_used_session": self.tokens_used,
            "token_limit_session": agent.token_limit,
            "latency_ms": None,
            "tool_name": None,
            "tool_input": None,
            "tool_result": None,
            "has_content": False,
            "content": None,
            "capture_prompts": False,
            "timestamp": stamp(at),
        }
        if agent.role:
            payload["agent_role"] = agent.role
        payload.update(fields)
        self.client.event(payload)

    def start(self, at: float) -> None:
        agent = self.agent
        context: dict[str, Any] = {
            "os": "Darwin" if agent.agent_type == "coding" else "Linux",
            "arch": "arm64" if agent.agent_type == "coding" else "x86_64",
            "hostname": agent.hostname,
            "user": agent.user,
            "git_branch": "main",
            "git_repo": "acme-agents" if agent.agent_type == "production" else "acme-web",
        }
        if agent.framework:
            context["frameworks"] = [agent.framework]
        if agent.mcp:
            context["mcp_servers"] = [{"name": agent.mcp.name, "transport": agent.mcp.transport}]
        fields: dict[str, Any] = {"context": context, "sensor_version": SENSOR_VERSION}
        if self.parent is not None:
            fields["parent_session_id"] = self.parent.session_id
        self._event("session_start", at, **fields)
        self.client.wait_for_session(self.session_id)

    def call(self, at: float) -> float:
        """One model call and, most times, a tool or MCP call after it.
        Returns the time the step ended."""
        agent, rng = self.agent, self.rng
        tokens_in = rng.randint(*agent.tokens_in)
        tokens_out = rng.randint(*agent.tokens_out)
        latency = rng.randint(*agent.latency_ms)
        self._event(
            "pre_call", at, model=agent.model, tokens_input=tokens_in, provider=agent.provider
        )
        self.tokens_used += tokens_in + tokens_out
        done = at + latency / 1000
        self._event(
            "post_call",
            done,
            model=agent.model,
            provider=agent.provider,
            billing_mode=agent.billing_mode,
            tokens_input=tokens_in,
            tokens_output=tokens_out,
            tokens_total=tokens_in + tokens_out,
            tokens_used_session=self.tokens_used,
            latency_ms=latency,
        )
        roll = rng.random()
        if agent.mcp and roll < 0.45:
            done += 0.4
            self._event(
                "mcp_tool_call",
                done,
                server_name=agent.mcp.name,
                transport=agent.mcp.transport,
                tool_name=rng.choice(agent.mcp.tools),
                duration_ms=rng.randint(40, 900),
            )
        elif roll < 0.85:
            done += 0.3
            self._event("tool_call", done, tool_name=rng.choice(agent.tools))
        limit = agent.token_limit
        if limit and not self.warned and self.tokens_used >= 0.8 * limit:
            self.warned = True
            done += 0.1
            self.policy_event("policy_warn", done, threshold_pct=80)
        return done

    def policy_event(self, event_type: str, at: float, threshold_pct: int, **fields: Any) -> None:
        agent = self.agent
        decision = "warn" if event_type == "policy_warn" else "block"
        self._event(
            event_type,
            at,
            source="server",
            threshold_pct=threshold_pct,
            tokens_used=self.tokens_used,
            token_limit=agent.token_limit,
            policy_decision={
                "policy_id": f"token-budget-{agent.flavor}",
                "scope": f"flavor:{agent.flavor}",
                "decision": decision,
                "reason": (
                    f"{self.tokens_used:,} of {agent.token_limit:,} tokens used "
                    f"({threshold_pct}% threshold)"
                ),
            },
            **fields,
        )

    def mcp_block(self, at: float, server: McpServer) -> None:
        agent = self.agent
        self._event(
            "policy_mcp_block",
            at,
            server_url=server.url,
            server_name=server.name,
            fingerprint=uuid5(NAMESPACE_FLIGHTDECK, server.url + "\x00" + server.name).hex[:16],
            tool_name=server.tools[0],
            policy_id=f"mcp-{agent.flavor}",
            scope=f"flavor:{agent.flavor}",
            decision_path="flavor_entry",
            transport=server.transport,
            block_on_uncertainty=False,
            policy_decision={
                "policy_id": f"mcp-{agent.flavor}",
                "scope": f"flavor:{agent.flavor}",
                "decision": "block",
                "reason": f"Server {server.name} blocked by flavor entry, enforcement=block",
                "decision_path": "flavor_entry",
            },
        )

    def error(self, at: float) -> None:
        self._event(
            "llm_error",
            at,
            model=self.agent.model,
            retry_attempt=1,
            error={
                "error_type": "rate_limit",
                "provider": self.agent.provider,
                "http_status": 429,
                "provider_error_code": "rate_limit_exceeded",
                "error_message": "rate limit reached, retrying",
                "request_id": "req_demo_rate_limit",
                "retry_after": 2,
                "is_retryable": True,
            },
        )

    def end(self, at: float) -> None:
        self._event("session_end", at)


def seed_history(client: Client, now: float, rng: random.Random) -> None:
    """Closed runs over the last HISTORY_HOURS, busier in working hours."""
    for agent in FLEET:
        if agent.parent is not None:
            continue  # sub-agent runs are created with their parent's
        children = [a for a in FLEET if a.parent is agent]
        total_runs = max(1, round(agent.runs_per_day * HISTORY_HOURS / 24))
        for n in range(total_runs):
            # Evenly spaced with jitter, oldest first, none in the last
            # ten minutes (the open runs own that stretch).
            span = HISTORY_HOURS * 3600 - 600
            started = now - span + span * (n + rng.random() * 0.7) / total_runs
            run = Run(client, agent, f"history-{n}", rng)
            run.tokens_used = int((agent.token_limit or 0) * 0.3 * rng.random())
            run.start(started)
            at = started + 1.0
            for _ in range(rng.randint(*agent.calls_per_run)):
                at = run.call(at) + rng.uniform(0.5, 4.0)
            for child_agent in children:
                child = Run(client, child_agent, f"history-{n}", rng, parent=run)
                child.start(at)
                child_at = at + 0.5
                for _ in range(rng.randint(*child_agent.calls_per_run)):
                    child_at = child.call(child_at) + rng.uniform(0.3, 2.0)
                child.end(child_at)
                at = child_at + 0.5
            if agent is CODE_REVIEW and n % 4 == 1:
                run.error(at)
                at += 2.5
                at = run.call(at)
            if agent is SQL_ANALYST and n == total_runs - 1:
                # The newest run of the budgeted analyst runs out of
                # budget: a warning, then a refused call.
                run.tokens_used = int(agent.token_limit * 0.97)
                run.warned = True
                run.policy_event("policy_warn", at, threshold_pct=80)
                at = run.call(at + 1.0)
                run.tokens_used = max(run.tokens_used, agent.token_limit + 1200)
                run.policy_event(
                    "policy_block", at + 0.5, threshold_pct=100, intended_model=agent.model
                )
                at += 1.0
            run.end(at + 0.5)


def seed_policies(client: Client) -> None:
    """The token budgets and MCP rules the Policies page lists, matching
    the policy events the runs emit."""
    for agent in FLEET:
        if agent.token_limit and agent.parent is None:
            client.policy(agent.flavor, agent.token_limit)
    client.mcp_policy(
        RESEARCH.flavor,
        [
            {
                "server_url": WEB_SEARCH.url,
                "server_name": WEB_SEARCH.name,
                "entry_kind": "allow",
                "enforcement": "warn",
            },
            {
                "server_url": SCRATCH_FS.url,
                "server_name": SCRATCH_FS.name,
                "entry_kind": "deny",
                "enforcement": "block",
            },
        ],
    )
    client.mcp_policy(
        SUPPORT.flavor,
        [
            {
                "server_url": HELPDESK.url,
                "server_name": HELPDESK.name,
                "entry_kind": "allow",
                "enforcement": "warn",
            },
        ],
    )


def seed_live(client: Client, now: float, rng: random.Random) -> list[Run]:
    """One open run per LIVE agent, its events ending just before now."""
    runs: dict[int, Run] = {}
    for agent in LIVE:
        parent = runs.get(id(agent.parent)) if agent.parent is not None else None
        run = Run(client, agent, "live", rng, parent=parent)
        if agent is SUPPORT:
            # Close to its budget, so the warning lands in the window.
            run.tokens_used = int(agent.token_limit * 0.78)
        offset = LIVE_RUN_STARTED_SECS - (4 if agent.parent is not None else 0) - rng.uniform(0, 6)
        run.start(now - offset)
        runs[id(agent)] = run
    ordered = list(runs.values())
    # Round-robin the runs' calls across the window so every row has
    # events spread over it.
    cursor = {id(run): now - LIVE_RUN_STARTED_SECS + 8 + rng.uniform(0, 5) for run in ordered}
    newest = now - LIVE_RUN_NEWEST_EVENT_SECS
    progressed = True
    while progressed:
        progressed = False
        for run in ordered:
            at = cursor[id(run)]
            latest_start = newest - run.agent.latency_ms[1] / 1000 - 1.0
            if at > latest_start:
                continue
            cursor[id(run)] = run.call(at) + rng.uniform(1.5, 7.0)
            progressed = True
            if run.agent is RESEARCHER and not run.warned and at > now - 30:
                # The researcher reaches for a server its flavor denies.
                run.warned = True
                run.mcp_block(cursor[id(run)] - 1.0, SCRATCH_FS)
    return ordered


def keep_live(runs: list[Run], seconds: float, rng: random.Random) -> None:
    """Has the open runs emit in real time for a recording. The
    researcher keeps reaching for the server its flavor denies, so a
    blocked call is always among its newest events."""
    researcher = next((run for run in runs if run.agent is RESEARCHER), None)
    deadline = time.monotonic() + seconds
    round_number = 0
    while time.monotonic() < deadline:
        for run in rng.sample(runs, k=max(1, len(runs) // LIVE_ROUND_SHARE)):
            run.call(time.time() - run.agent.latency_ms[0] / 1000)
        if researcher is not None and round_number % LIVE_BLOCK_EVERY_ROUNDS == 0:
            researcher.mcp_block(time.time(), SCRATCH_FS)
        round_number += 1
        time.sleep(LIVE_ROUND_SECS)


def refusal(server: str, allow_default_port: bool, allow_remote: bool) -> str | None:
    """Why this server must not be seeded, or None when it may be. The
    seed is for an instance on this machine that will be thrown away:
    a server on another host, or on the port a Flightdeck with real
    data usually listens on, is refused unless its flag says otherwise."""
    target = urllib.parse.urlsplit(server)
    host = (target.hostname or "").lower()
    try:
        local = host == LOOPBACK_NAME or ipaddress.ip_address(host).is_loopback
    except ValueError:  # a host name other than localhost
        local = False
    if not local and not allow_remote:
        return (
            f"{server} is not on this machine; the seed is for a throwaway Flightdeck "
            "on localhost (see this script's header), or pass --allow-remote"
        )
    if target.port == DEFAULT_PORT and not allow_default_port:
        return (
            f"{server} is on port {DEFAULT_PORT}, where a Flightdeck with real data "
            "usually listens; start a throwaway one on another port (see this script's "
            "header), or pass --allow-default-port"
        )
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--server", required=True, help="the Flightdeck to seed, e.g. http://127.0.0.1:4610"
    )
    parser.add_argument(
        "--token", default=DEV_TOKEN, help="access token (default: the development token)"
    )
    parser.add_argument(
        "--live",
        type=float,
        default=0,
        metavar="SECONDS",
        help="after seeding, keep the open runs emitting for this long",
    )
    parser.add_argument(
        "--no-history", action="store_true", help="seed only the open runs and the policies"
    )
    parser.add_argument(
        "--allow-default-port",
        action="store_true",
        help=f"seed a server on port {DEFAULT_PORT}, where real data usually lives",
    )
    parser.add_argument(
        "--allow-remote",
        action="store_true",
        help="seed a server that is not on this machine",
    )
    args = parser.parse_args(argv)

    refused = refusal(args.server, args.allow_default_port, args.allow_remote)
    if refused:
        parser.error(refused)

    client = Client(args.server, args.token)
    rng = random.Random(RANDOM_SEED)
    now = time.time()
    try:
        seed_policies(client)
        if not args.no_history:
            seed_history(client, now, rng)
            print(f"history: {client.posted} events over the last {HISTORY_HOURS} hours")
        # The open runs are stamped against the clock as it is after
        # the history was posted, so their newest events are fresh.
        runs = seed_live(client, time.time(), rng)
        print(f"seeded {client.posted} events; {len(runs)} runs left open")
        if args.live > 0:
            before = client.posted
            keep_live(runs, args.live, rng)
            print(f"live: {client.posted - before} events in {args.live:g} s")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        print(f"demo-seed: {exc.url} answered {exc.code}: {detail}", file=sys.stderr)
        print(
            "demo-seed: seed a new instance: this one may already hold the fleet", file=sys.stderr
        )
        return 1
    except urllib.error.URLError as exc:
        print(f"demo-seed: cannot reach {args.server}: {exc.reason}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
