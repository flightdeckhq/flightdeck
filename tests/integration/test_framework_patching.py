"""Framework patching integration tests (Phase 4.5+ Phase 3).

Proves that after ``flightdeck_sensor.init()`` and
``flightdeck_sensor.patch()``, LLM calls made *through* an agent
framework -- without any explicit ``wrap()`` call -- are intercepted
and reach the control plane DB and the fleet API.

The empirical investigation in Phase 1 found that three of the four
frameworks tested have NO usable external-client injection point and
the fourth (``llama-index-llms-openai``) requires the obscure
``openai_client=`` kwarg name. Class-level patching is the only
viable transparent intercept mechanism for these frameworks. These
tests prove the mechanism end-to-end against the live dev stack.

Each test follows the same shape:

1. ``init()`` then ``patch()`` (no ``wrap()``).
2. Construct the framework LLM object with NO client kwarg, so the
   framework builds its own internal Anthropic / OpenAI client.
3. Make a call through the framework. ``respx`` mocks the provider
   HTTP endpoint with a 50 ms latency tick to keep the producer
   rate at ~realistic LLM RTT.
4. Verify ``session_start``, ``pre_call``, and ``post_call`` events
   land in the DB with the correct token counts.
5. Verify ``GET /v1/fleet`` shows the session under the right
   flavor and the runtime ``context`` (``hostname``, ``os``,
   ``python_version``) is populated.
6. ``teardown()`` in a ``finally`` block.

There is no per-framework "is the patch active" check inside these
tests -- the assertion that ``post_call`` lands in the DB is the
only proof that matters. If the patch were inactive, the framework's
internal client would emit no events.

Two additional behavioural tests cover the captured-reference fix
end-to-end and the documented "pre-existing instances are not
intercepted" limitation:

* ``test_captured_anthropic_reference_intercepted_after_patch`` --
  imports ``Anthropic`` BEFORE ``patch()``, then calls ``patch()``,
  then constructs and uses the captured reference. Proves the
  captured-reference fix works against the live DB.
* ``test_pre_existing_instance_not_intercepted`` -- constructs an
  ``Anthropic`` instance and accesses ``.messages`` BEFORE
  ``patch()``. Calls ``patch()``. Uses the pre-existing instance to
  make a call. Verifies NO ``post_call`` lands in the DB. Documents
  the known cached_property limitation end-to-end so future
  developers understand the boundary.
"""

from __future__ import annotations

import os
import time
import uuid
from collections.abc import Iterator
from typing import Any

import anthropic
import httpx
import openai
import pytest
import respx

import flightdeck_sensor
from flightdeck_sensor import _directive_registry

from .conftest import (
    INGESTION_URL,
    TOKEN,
    wait_until,
)
from .test_sensor_e2e import (
    ANTHROPIC_RESPONSE,
    OPENAI_RESPONSE,
    _delete_flavor_data,
    _query_events_for_flavor,
    _query_session_for_flavor,
    _wait_for_event_type,
)


# ----------------------------------------------------------------------
# Fixtures
# ----------------------------------------------------------------------


def _force_reset_sensor() -> None:
    """Force the sensor module-level state back to its uninitialised form."""
    try:
        flightdeck_sensor.teardown()
    except Exception:
        pass
    flightdeck_sensor._session = None
    flightdeck_sensor._client = None
    _directive_registry.clear()


@pytest.fixture
def sensor_reset() -> Iterator[None]:
    """Ensure clean sensor state before and after each test.

    Mirrors the fixture in test_sensor_e2e.py. Duplicated here so the
    framework patching tests do not depend on test_sensor_e2e.py being
    importable as a module (it is, but the dependency edge is one-way:
    we import its helpers but not its fixtures).
    """
    _force_reset_sensor()
    yield
    _force_reset_sensor()


@pytest.fixture
def unique_flavor() -> Iterator[str]:
    """Yield a unique flavor name for test isolation; cleanup DB rows after."""
    flavor = f"fwk-{uuid.uuid4().hex[:10]}"
    os.environ["AGENT_FLAVOR"] = flavor
    try:
        yield flavor
    finally:
        os.environ.pop("AGENT_FLAVOR", None)
        _delete_flavor_data(flavor)


# ----------------------------------------------------------------------
# Mock helpers (50 ms latency for realistic producer rate)
# ----------------------------------------------------------------------


def _mock_anthropic_with_latency(rmock: respx.MockRouter) -> None:
    """Mock https://api.anthropic.com/v1/messages with 50 ms latency."""
    def _delayed(_request: httpx.Request) -> httpx.Response:
        time.sleep(0.05)
        return httpx.Response(200, json=ANTHROPIC_RESPONSE)

    rmock.post("https://api.anthropic.com/v1/messages").mock(
        side_effect=_delayed
    )


def _mock_openai_with_latency(rmock: respx.MockRouter) -> None:
    """Mock https://api.openai.com/v1/chat/completions with 50 ms latency."""
    def _delayed(_request: httpx.Request) -> httpx.Response:
        time.sleep(0.05)
        return httpx.Response(200, json=OPENAI_RESPONSE)

    rmock.post("https://api.openai.com/v1/chat/completions").mock(
        side_effect=_delayed
    )


# ----------------------------------------------------------------------
# Verification helper
# ----------------------------------------------------------------------


def _assert_session_in_fleet_with_context(flavor: str) -> dict[str, Any]:
    """Verify the session for ``flavor`` exists in GET /v1/fleet.

    Asserts that ``hostname``, ``os``, and ``python_version`` are
    present in the session's runtime context. Returns the session
    dict from the DB so the caller can do further checks.
    """
    sess = _query_session_for_flavor(flavor)
    assert sess is not None, f"no session row for flavor {flavor}"

    # The DB session row's ``context`` JSONB column carries the
    # runtime context dict. The fleet API surfaces this same column
    # via the session payload, so verifying it on the DB row is
    # equivalent to verifying it via the API for the keys we care
    # about. We also call get_fleet() below to confirm the session
    # is reachable through the public API surface.
    ctx = sess.get("context") or {}
    assert "hostname" in ctx, f"hostname missing from context: {ctx}"
    assert "os" in ctx, f"os missing from context: {ctx}"
    assert "python_version" in ctx, (
        f"python_version missing from context: {ctx}"
    )

    # Reach for the public fleet API: verify the session is visible
    # through GET /v1/fleet (not just sitting in the DB). Use the
    # paginated helper from conftest so we tolerate cross-test fleet
    # accumulation.
    from .conftest import get_fleet
    fleet = get_fleet()
    found = False
    for f in fleet.get("flavors", []):
        if f.get("flavor") == flavor:
            for s in f.get("sessions", []):
                if s.get("session_id") == sess["session_id"]:
                    found = True
                    break
        if found:
            break
    assert found, (
        f"session {sess['session_id']} for flavor {flavor} "
        f"not visible via GET /v1/fleet"
    )
    return sess


def _assert_full_pipeline_event_chain(
    flavor: str, expected_model: str
) -> dict[str, Any]:
    """Wait for session_start and post_call in DB; return the post_call row.

    Verifies token counts on post_call match the mock response (10
    input + 8 output = 18 total). Both Anthropic and OpenAI mock
    payloads use the same shape so a single helper covers both.

    Note on pre_call events: ``EventType.PRE_CALL`` exists in the
    sensor's enum but is NEVER emitted by the wrap/patch interceptor
    path -- ``base._pre_call`` only runs the policy check, it does
    not enqueue an event. The dashboard's pre_call events come from
    the Claude Code plugin's PreToolUse hook, not from this sensor
    path. Verifying ``session_start`` + ``post_call`` is the correct
    end-to-end proof for ``flightdeck_sensor.patch()`` interception.
    Confirmed by reading
    ``sensor/flightdeck_sensor/interceptor/base.py`` line by line and
    by ``grep -rn 'EventType.PRE_CALL'`` returning only the enum
    declaration site, never an emission site.
    """
    _wait_for_event_type(flavor, "session_start", timeout=10)
    post_call = _wait_for_event_type(flavor, "post_call", timeout=15)
    assert post_call["tokens_input"] == 10, (
        f"expected tokens_input=10, got {post_call.get('tokens_input')}"
    )
    assert post_call["tokens_output"] == 8, (
        f"expected tokens_output=8, got {post_call.get('tokens_output')}"
    )
    assert post_call["tokens_total"] == 18, (
        f"expected tokens_total=18, got {post_call.get('tokens_total')}"
    )
    # The framework may pass through whatever model name the user
    # supplied; we accept any non-empty string but log it for debugging.
    assert post_call.get("model"), (
        f"post_call has no model field: {post_call}"
    )
    return post_call


# ======================================================================
# Test 1 -- langchain-anthropic ChatAnthropic
# ======================================================================


def test_langchain_anthropic_patched_intercepts_call(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """ChatAnthropic with no client kwarg is intercepted via patch().

    The framework constructs its own ``anthropic.Anthropic`` instance
    inside ``__init__``. After ``patch()``, that internal client's
    ``messages`` ``cached_property`` is the sensor's descriptor, so
    the first ``.messages`` access wraps the real Messages resource
    in a ``SensorMessages`` and the LLM call goes through the
    sensor's pre/post intercept pipeline.
    """
    flavor = unique_flavor

    # langchain-anthropic checks for the API key in the environment
    # at construction time when no explicit api_key kwarg is passed.
    os.environ["ANTHROPIC_API_KEY"] = "test-key"
    try:
        with respx.mock(assert_all_called=False) as rmock:
            _mock_anthropic_with_latency(rmock)

            flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
            flightdeck_sensor.patch()

            # Lazy import: avoid module-load-time failure if the
            # framework package is not installed in the local dev env.
            from langchain_anthropic import ChatAnthropic

            # No client kwarg -- the framework builds its own
            # anthropic.Anthropic internally.
            llm = ChatAnthropic(model="claude-sonnet-4-6")
            response = llm.invoke("Hello from langchain")

            # The mock returns "Hello from mock Anthropic"; langchain
            # wraps this in an AIMessage. We don't assert on the
            # exact response shape -- the DB events are the proof.
            assert response is not None

            # Wait for the full event chain to land in the DB.
            _assert_full_pipeline_event_chain(flavor, "claude-sonnet-4-6")

            # And verify the session is visible via the public fleet API
            # with runtime context populated.
            _assert_session_in_fleet_with_context(flavor)
    finally:
        os.environ.pop("ANTHROPIC_API_KEY", None)


# ======================================================================
# Test 2 -- langchain-openai ChatOpenAI
# ======================================================================


def test_langchain_openai_patched_intercepts_call(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """ChatOpenAI with no client kwarg is intercepted via patch()."""
    flavor = unique_flavor

    os.environ["OPENAI_API_KEY"] = "test-key"
    try:
        with respx.mock(assert_all_called=False) as rmock:
            _mock_openai_with_latency(rmock)

            flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
            flightdeck_sensor.patch()

            from langchain_openai import ChatOpenAI

            llm = ChatOpenAI(model="gpt-4o")
            response = llm.invoke("Hello from langchain")
            assert response is not None

            _assert_full_pipeline_event_chain(flavor, "gpt-4o")
            _assert_session_in_fleet_with_context(flavor)
    finally:
        os.environ.pop("OPENAI_API_KEY", None)


# ======================================================================
# Test 3 -- llama-index-llms-anthropic
# ======================================================================


def test_llama_index_anthropic_patched_intercepts_call(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """llama-index-llms-anthropic Anthropic LLM is intercepted via patch().

    llama_index.llms.anthropic.Anthropic eagerly constructs both
    ``_client`` (sync) and ``_aclient`` (async) inside ``__init__``.
    After ``patch()``, both go through the sensor's class-level
    descriptor on first ``.messages`` access. Calls via ``complete()``
    or ``chat()`` produce post_call events in the DB.
    """
    flavor = unique_flavor

    os.environ["ANTHROPIC_API_KEY"] = "test-key"
    try:
        with respx.mock(assert_all_called=False) as rmock:
            _mock_anthropic_with_latency(rmock)

            flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
            flightdeck_sensor.patch()

            from llama_index.llms.anthropic import Anthropic as LIAnthropic

            llm = LIAnthropic(model="claude-sonnet-4-6")
            # llama_index complete() returns a CompletionResponse.
            response = llm.complete("Hello from llama-index")
            assert response is not None

            _assert_full_pipeline_event_chain(flavor, "claude-sonnet-4-6")
            _assert_session_in_fleet_with_context(flavor)
    finally:
        os.environ.pop("ANTHROPIC_API_KEY", None)


# ======================================================================
# Test 4 -- llama-index-llms-openai
# ======================================================================


def test_llama_index_openai_patched_intercepts_call(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """llama-index-llms-openai OpenAI LLM is intercepted via patch().

    llama_index.llms.openai.OpenAI uses lazy client construction --
    ``_client`` is None until the first call, then built on demand.
    The sensor patch must be active at the time of FIRST USE, not
    construction time. Verifies the patch survives the lazy
    construction path.
    """
    flavor = unique_flavor

    os.environ["OPENAI_API_KEY"] = "test-key"
    try:
        with respx.mock(assert_all_called=False) as rmock:
            _mock_openai_with_latency(rmock)

            flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
            flightdeck_sensor.patch()

            from llama_index.llms.openai import OpenAI as LIOpenAI

            llm = LIOpenAI(model="gpt-4o")
            response = llm.complete("Hello from llama-index")
            assert response is not None

            _assert_full_pipeline_event_chain(flavor, "gpt-4o")
            _assert_session_in_fleet_with_context(flavor)
    finally:
        os.environ.pop("OPENAI_API_KEY", None)


# ======================================================================
# Test 5 -- captured reference still intercepted after patch()
# ======================================================================


def test_captured_anthropic_reference_intercepted_after_patch(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """Captured ``from anthropic import Anthropic`` works after patch().

    This is the end-to-end version of the unit test
    ``test_captured_reference_still_works_after_patch``. The unit
    test asserts class identity; this test asserts the post_call
    actually lands in the DB after going through a captured class
    reference.

    The previous closure-based patch() approach replaced the
    ``anthropic.Anthropic`` MODULE attribute with a function thunk,
    leaving captured references pointing at the unmodified original
    class -- so any code that did ``from anthropic import Anthropic``
    at module load bypassed the patch entirely. The class-level
    patch in this branch mutates the actual class object, so
    captured references go through the descriptor.
    """
    flavor = unique_flavor

    # Capture the reference at module-load time, BEFORE patch() runs.
    # In the previous implementation this would bind to the original
    # class and bypass the thunk; in the new implementation this
    # binds to the same class object the patch will later mutate.
    from anthropic import Anthropic as CapturedAnthropic

    with respx.mock(assert_all_called=False) as rmock:
        _mock_anthropic_with_latency(rmock)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        flightdeck_sensor.patch()

        # Construct via the captured reference, NOT via
        # ``anthropic.Anthropic``. They should be the same object now,
        # but using the captured reference exercises the cache-line
        # the framework would actually have.
        client = CapturedAnthropic(api_key="test-key")
        response = client.messages.create(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=100,
        )
        assert response.id == "msg_test123"

        post_call = _wait_for_event_type(flavor, "post_call", timeout=15)
        assert post_call["tokens_input"] == 10
        assert post_call["tokens_output"] == 8
        assert post_call["tokens_total"] == 18

        _assert_session_in_fleet_with_context(flavor)


# ======================================================================
# Test 6 -- pre-existing instance NOT intercepted (documented limitation)
# ======================================================================


def test_pre_existing_instance_not_intercepted(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """Documented limitation: instances created BEFORE patch() are NOT wrapped.

    ``anthropic.Anthropic.messages`` is a ``functools.cached_property``.
    On first access on an instance, the resource is cached into
    ``instance.__dict__``. Python's attribute lookup checks
    ``instance.__dict__`` BEFORE non-data descriptors on the class,
    so once the cache is populated the descriptor is bypassed
    entirely.

    Therefore: an instance constructed AND first-accessed before
    ``patch()`` ran has the unwrapped raw ``Messages`` cached in
    its ``__dict__``. After ``patch()`` installs the new descriptor
    on the class, this instance still hits its own cached value
    and bypasses the descriptor on every subsequent access. Calls
    through this instance are NOT intercepted.

    This is a known limitation of any cached_property-based intercept
    approach. The Phase 4.5+ Phase 2 design accepts it because:

    * Frameworks construct LLM clients during agent setup, well
      before any LLM call loop begins. ``init()`` + ``patch()``
      runs at agent startup, which precedes framework setup in
      practice.
    * Walking arbitrary live instances to clear their __dict__
      caches is not feasible without a heavy gc traversal.
    * The unit test ``test_descriptor_caches_messages_on_instance``
      proves the cache behavior; this test proves the resulting
      end-to-end limitation against the live DB.

    This test exists to document the boundary so a future developer
    sees a deliberate "this is intentional" assertion rather than
    discovering the gap by accident.
    """
    flavor = unique_flavor

    with respx.mock(assert_all_called=False) as rmock:
        _mock_anthropic_with_latency(rmock)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)

        # Construct AND first-access the messages resource BEFORE
        # patch(). The first access populates instance.__dict__
        # with the raw, unwrapped Messages object.
        client = anthropic.Anthropic(api_key="test-key")
        _ = client.messages  # populates instance.__dict__["messages"]
        assert "messages" in vars(client), (
            "precondition: messages must be cached on the instance "
            "before patch() runs"
        )

        # NOW patch the class. The descriptor lands on
        # anthropic.Anthropic.messages, but this specific instance
        # already has the raw Messages cached in its __dict__ which
        # shadows any class-level descriptor.
        flightdeck_sensor.patch()

        # Make a call through the pre-existing instance. The Messages
        # object it accesses is the unwrapped raw one, so the call
        # never goes through the sensor's intercept pipeline. The
        # mock still answers the HTTP request because respx is
        # patching at a lower layer (httpx transport), but no
        # post_call event reaches the DB.
        response = client.messages.create(
            model="claude-sonnet-4-6",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=100,
        )
        assert response.id == "msg_test123"

        # session_start IS in the DB because Session.start() ran
        # synchronously inside init(). That's the only event we
        # expect to find.
        _wait_for_event_type(flavor, "session_start", timeout=10)

        # Wait a bounded period for any post_call to potentially
        # appear, then assert it has NOT appeared. We can't
        # ``wait_until`` for the negative case because that loops
        # forever; instead we sleep a fixed budget that's well
        # beyond normal drain latency (which the slow_handler test
        # established at sub-second under realistic producer rates),
        # then check the DB once.
        time.sleep(2.0)

        events = _query_events_for_flavor(flavor)
        post_calls = [e for e in events if e.get("event_type") == "post_call"]
        assert post_calls == [], (
            "pre-existing instance limitation broken: expected zero "
            "post_call events for a client constructed AND first-accessed "
            "before patch(), but found "
            f"{len(post_calls)}: {post_calls}"
        )

        # And session_start is the only event we expect to see.
        event_types = sorted({e.get("event_type") for e in events})
        assert event_types == ["session_start"], (
            f"expected only session_start events, got {event_types}"
        )
