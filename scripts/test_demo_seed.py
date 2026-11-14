"""Tests of scripts/demo_seed.py against a fake Flightdeck.

Run: python3 -m unittest scripts/test_demo_seed.py

The fake answers the four requests the seed makes (an event, a session
lookup, a token policy, an MCP policy) and records the events, so the
tests read what a real ingestion API would have been sent. Nothing
here reaches a real Flightdeck.
"""

from __future__ import annotations

import contextlib
import io
import json
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_DNS, uuid5

sys.path.insert(0, str(Path(__file__).resolve().parent))

import demo_seed  # noqa: E402

# The fields ingestion requires on every event, and the ones that would
# carry content if the seed ever sent any.
IDENTITY_FIELDS = ("session_id", "flavor", "agent_id", "agent_type", "agent_name", "client_type")
CONTENT_FIELDS = ("content", "tool_input", "tool_result")

# Every host and user the fleet may name. A name outside these lists is
# either a typo or a real one that slipped in.
INVENTED_HOSTS = {"prod-agents-1", "prod-agents-2", "ci-runner-3", "dev-laptop"}
INVENTED_USERS = {"svc-agents", "ci", "alex"}

POLICY_EVENTS = {"policy_warn", "policy_block", "policy_mcp_block"}


class FakeFlightdeck:
    """An HTTP server that accepts what the seed posts and keeps the
    events. ``refuse_events_with`` makes the event endpoint answer that
    status instead."""

    def __init__(self, refuse_events_with: int | None = None) -> None:
        self.events: list[dict[str, Any]] = []
        self.policies: list[tuple[str, dict[str, Any]]] = []
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:  # silence the access log
                pass

            def _answer(self, status: int, body: dict[str, Any]) -> None:
                raw = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self) -> None:  # noqa: N802 (the handler's interface)
                self._answer(200, {"session": {}})

            def do_POST(self) -> None:  # noqa: N802
                length = int(self.headers.get("Content-Length", "0"))
                body = json.loads(self.rfile.read(length) or b"{}")
                if self.path == "/ingest/v1/events":
                    if refuse_events_with is not None:
                        self._answer(refuse_events_with, {"error": "rate limit exceeded"})
                        return
                    fake.events.append(body)
                    self._answer(200, {"status": "ok"})
                    return
                fake.policies.append((self.path, body))
                self._answer(201, {})

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._server.server_address[1]}"
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)


def run_seed(*args: str, refuse_events_with: int | None = None) -> tuple[Any, FakeFlightdeck, str]:
    """Runs the seed's main() against a new fake. Returns its exit code
    (or the SystemExit payload), the fake and what it printed."""
    fake = FakeFlightdeck(refuse_events_with=refuse_events_with)
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            try:
                code: Any = demo_seed.main(["--server", fake.url, *args])
            except SystemExit as exc:
                code = exc.code
    finally:
        fake.close()
    return code, fake, out.getvalue()


def without_time(event: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in event.items() if k != "timestamp"}


class TestIdentity(unittest.TestCase):
    def test_namespace_is_the_sensors(self) -> None:
        # The sensor's namespace is uuid5(NAMESPACE_DNS, "flightdeck.dev")
        # (sensor/tests/unit/test_agent_id.py pins the same derivation).
        self.assertEqual(demo_seed.NAMESPACE_FLIGHTDECK, uuid5(NAMESPACE_DNS, "flightdeck.dev"))

    def test_agent_id_follows_the_sensors_grammar(self) -> None:
        namespace = uuid5(NAMESPACE_DNS, "flightdeck.dev")
        root = "flightdeck://production/svc-agents@prod-agents-1/flightdeck_sensor/support-triage"
        self.assertEqual(demo_seed.SUPPORT.agent_id, str(uuid5(namespace, root)))
        child = (
            "flightdeck://production/svc-agents@prod-agents-1/flightdeck_sensor"
            "/research-assistant/Researcher"
        )
        self.assertEqual(demo_seed.RESEARCHER.agent_id, str(uuid5(namespace, child)))

    def test_every_row_of_the_fleet_is_its_own_agent(self) -> None:
        ids = [agent.agent_id for agent in demo_seed.FLEET]
        self.assertEqual(len(ids), len(set(ids)))

    def test_the_fleet_names_only_invented_hosts_and_users(self) -> None:
        self.assertEqual({agent.hostname for agent in demo_seed.FLEET}, INVENTED_HOSTS)
        self.assertEqual({agent.user for agent in demo_seed.FLEET}, INVENTED_USERS)

    def test_the_fleet_is_six_to_eight_agents_with_sub_agents(self) -> None:
        roots = [agent for agent in demo_seed.FLEET if agent.parent is None]
        children = [agent for agent in demo_seed.FLEET if agent.parent is not None]
        self.assertTrue(6 <= len(roots) <= 8, len(roots))
        claude_code = [a for a in children if a.client_type == "claude_code"]
        self.assertEqual(len(claude_code), 2)
        # A parent is listed before its sub-agents: sessions are created
        # in this order and a child's session names its parent's.
        for child in children:
            self.assertLess(demo_seed.FLEET.index(child.parent), demo_seed.FLEET.index(child))


class TestArguments(unittest.TestCase):
    def test_the_default_port_is_refused(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stderr(out), self.assertRaises(SystemExit) as raised:
            demo_seed.main(["--server", "http://localhost:4000"])
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("real data", out.getvalue())

    def test_a_server_on_another_machine_is_refused(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stderr(out), self.assertRaises(SystemExit) as raised:
            demo_seed.main(["--server", "https://flightdeck.example.com"])
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("not on this machine", out.getvalue())

    def test_which_servers_are_refused(self) -> None:
        refusal = demo_seed.refusal
        for server in (
            "http://127.0.0.1:4610",
            "http://localhost:4610",
            "http://[::1]:4610",
            "http://127.0.0.2:4610",
            "http://LOCALHOST:4610",
        ):
            self.assertIsNone(refusal(server, False, False), server)
        for server in (
            "https://flightdeck.example.com",
            "http://10.0.0.5:4610",
            "http://localhost.example.com:4610",
            "http://127.example.com:4610",
            "http://example.com:4610/?x=localhost",
        ):
            self.assertIn("not on this machine", refusal(server, False, False) or "", server)
            self.assertIsNone(refusal(server, False, True), server)
        # Each flag lifts its own refusal only.
        self.assertIn("port 4000", refusal("http://localhost:4000", False, True) or "")
        self.assertIn("not on this machine", refusal("http://10.0.0.5:4000", True, False) or "")
        self.assertIn("port 4000", refusal("http://10.0.0.5:4000", False, True) or "")
        self.assertIsNone(refusal("http://10.0.0.5:4000", True, True))

    def test_a_server_must_be_named(self) -> None:
        # No default and no environment variable: the seed never picks a
        # Flightdeck on its own.
        out = io.StringIO()
        with contextlib.redirect_stderr(out), self.assertRaises(SystemExit) as raised:
            demo_seed.main([])
        self.assertEqual(raised.exception.code, 2)

    def test_a_rate_limited_event_names_the_variable(self) -> None:
        code, _, _ = run_seed("--no-history", refuse_events_with=429)
        self.assertIn("429", str(code))
        self.assertIn(demo_seed.RATE_LIMIT_VARIABLE, str(code))

    def test_an_unreachable_server_is_exit_1(self) -> None:
        fake = FakeFlightdeck()
        fake.close()
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
            code = demo_seed.main(["--server", fake.url, "--no-history"])
        self.assertEqual(code, 1)
        self.assertIn("cannot reach", out.getvalue())


class TestEvents(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.code, cls.fake, cls.output = run_seed()
        cls.events = cls.fake.events

    def test_the_seed_succeeds(self) -> None:
        self.assertEqual(self.code, 0, self.output)
        self.assertGreater(len(self.events), 1500)

    def test_every_event_carries_its_identity(self) -> None:
        for event in self.events:
            for name in IDENTITY_FIELDS:
                self.assertTrue(event.get(name), f"{event['event_type']} lacks {name}")
            self.assertIn(event["hostname"], INVENTED_HOSTS)
            self.assertIn(event["user"], INVENTED_USERS)

    def test_no_event_carries_content(self) -> None:
        for event in self.events:
            self.assertIs(event["capture_prompts"], False)
            self.assertIs(event["has_content"], False)
            for name in CONTENT_FIELDS:
                self.assertIsNone(event[name], f"{event['event_type']} carries {name}")

    def test_a_session_starts_before_its_events_and_its_children(self) -> None:
        started: set[str] = set()
        for event in self.events:
            if event["event_type"] == "session_start":
                parent = event.get("parent_session_id")
                if parent is not None:
                    self.assertIn(parent, started, "a sub-agent started before its parent")
                self.assertTrue(event["sensor_version"])
                started.add(event["session_id"])
            else:
                self.assertIn(event["session_id"], started)

    def test_the_fleet_shows_a_warning_and_both_kinds_of_block(self) -> None:
        kinds = {e["event_type"] for e in self.events}
        self.assertTrue(kinds >= POLICY_EVENTS, POLICY_EVENTS - kinds)
        for event in self.events:
            if event["event_type"] in POLICY_EVENTS:
                decision = event["policy_decision"]
                for name in ("policy_id", "scope", "decision", "reason"):
                    self.assertTrue(decision[name])

    def test_tools_mcp_calls_and_several_models_are_present(self) -> None:
        kinds = {e["event_type"] for e in self.events}
        self.assertTrue({"tool_call", "mcp_tool_call", "llm_error", "session_end"} <= kinds)
        models = {e["model"] for e in self.events if e["event_type"] == "post_call"}
        self.assertGreaterEqual(len(models), 5)
        frameworks = {e["framework"] for e in self.events}
        self.assertGreaterEqual(len(frameworks - {None}), 5)

    def test_the_open_runs_are_the_live_agents(self) -> None:
        ended = {e["session_id"] for e in self.events if e["event_type"] == "session_end"}
        started = {e["session_id"] for e in self.events if e["event_type"] == "session_start"}
        self.assertEqual(len(started - ended), len(demo_seed.LIVE))

    def test_the_policies_match_the_budgeted_agents(self) -> None:
        token_policies = [body for path, body in self.fake.policies if path == "/api/v1/policies"]
        self.assertEqual(
            {body["scope_value"] for body in token_policies},
            {a.flavor for a in demo_seed.FLEET if a.token_limit},
        )
        mcp_paths = {path for path, _ in self.fake.policies if "/mcp-policies/" in path}
        self.assertEqual(len(mcp_paths), 2)

    def test_two_runs_post_the_same_events(self) -> None:
        _, again, _ = run_seed()
        self.assertEqual(
            [without_time(e) for e in again.events],
            [without_time(e) for e in self.events],
        )


class TestLive(unittest.TestCase):
    def test_live_keeps_the_open_runs_emitting(self) -> None:
        _, quiet, _ = run_seed("--no-history")
        _, live, output = run_seed("--no-history", "--live", "2")
        self.assertGreater(len(live.events), len(quiet.events))
        self.assertIn("live:", output)
        # The researcher's denied call recurs from the first round on.
        blocks = [
            e for e in live.events[len(quiet.events) :] if e["event_type"] == "policy_mcp_block"
        ]
        self.assertGreaterEqual(len(blocks), 1)
        self.assertEqual({e["agent_role"] for e in blocks}, {"Researcher"})
        # Only the open runs emit, and none of them is ended.
        extra = live.events[len(quiet.events) :]
        ended = {e["session_id"] for e in live.events if e["event_type"] == "session_end"}
        for event in extra:
            self.assertNotIn(event["session_id"], ended)


if __name__ == "__main__":
    unittest.main()
