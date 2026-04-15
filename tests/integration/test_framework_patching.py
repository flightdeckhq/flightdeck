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
# Test 2b -- LangGraph via LangChain (ChatOpenAI)
# ======================================================================


def test_langgraph_patched_intercepts_call(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """LangGraph routes its LLM calls through LangChain's ChatOpenAI /
    ChatAnthropic, so the existing patch() already intercepts them.
    Verifies by compiling and invoking a one-node StateGraph that
    calls ChatOpenAI and asserting the full event chain reaches the
    DB under this flavor.

    Skips when either langgraph or langchain-openai isn't installed
    -- the Python 3.14 default dev env doesn't ship crewai's tiktoken
    dep, but langgraph installs cleanly, so this test usually runs.
    """
    try:
        from langgraph.graph import StateGraph, START, END
        from langchain_openai import ChatOpenAI
        from typing_extensions import TypedDict
    except ImportError as exc:
        pytest.skip(f"LangGraph / langchain_openai not installed: {exc}")

    flavor = unique_flavor

    os.environ["OPENAI_API_KEY"] = "test-key"
    try:
        with respx.mock(assert_all_called=False) as rmock:
            _mock_openai_with_latency(rmock)

            flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
            flightdeck_sensor.patch()

            class State(TypedDict):
                text: str

            llm = ChatOpenAI(model="gpt-4o")

            def call_node(state: State) -> State:
                llm.invoke(state["text"])
                return state

            graph = StateGraph(State)
            graph.add_node("call", call_node)
            graph.add_edge(START, "call")
            graph.add_edge("call", END)
            result = graph.compile().invoke({"text": "Hello from langgraph"})
            assert result is not None

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
# Test 5 -- CrewAI native OpenAI provider (default code path)
# ======================================================================
#
# CrewAI 1.14+ ships native provider classes
# (``crewai.llms.providers.openai.completion.OpenAICompletion`` and
# ``crewai.llms.providers.anthropic.completion.AnthropicCompletion``)
# that use the official ``openai`` and ``anthropic`` Python SDKs
# directly. They are NOT a litellm shim. The default ``crewai.LLM(model=...)``
# constructor returns one of these native classes when the model
# matches a supported provider (openai, anthropic, claude, azure,
# google, gemini, bedrock, openrouter, deepseek, ollama, ...). litellm
# is NOT a runtime dependency in CrewAI 1.14.
#
# Default call chain for ``LLM(model="gpt-4o-mini").call("...")``:
#
#   crewai.LLM.__new__
#     → OpenAICompletion(model="gpt-4o-mini")
#     → __init__ builds self._client = openai.OpenAI(...)
#   llm.call("Hello")
#     → OpenAICompletion.call
#     → _call_completions  (default api="completions")
#     → _handle_completion
#     → self._client.chat.completions.create(**params)
#     → SensorChat.completions  (via the patched OpenAI.chat descriptor)
#     → SensorCompletions.create  (intercepted) ✓
#
# CrewAI's optional ``HTTPTransport`` (in
# ``crewai/llms/hooks/transport.py``) sits at the httpx transport
# layer BELOW the SDK and runs CrewAI's own interceptor framework.
# It does NOT replace the SDK's ``messages.create`` /
# ``chat.completions.create`` entry points -- it's installed via
# ``http_client=`` kwarg on the SDK constructor and only intercepts
# the underlying HTTP request. Both layers coexist: the sensor's
# class-level patch fires at the resource-method layer (above), and
# CrewAI's hooks fire at the transport layer (below). The sensor
# pre/post events are emitted before and after the SDK call, which
# in turn drives a request through CrewAI's transport.
#
# Empirically verified by reading
# ``/site-packages/crewai/llms/providers/openai/completion.py`` line
# by line and by running an actual ``LLM(model="gpt-4o-mini").call(...)``
# against the live dev stack with a respx mock -- ``post_call|
# gpt-4o-mini|18`` lands in the events table for a fresh flavor.
#
# **Partial coverage caveat -- CrewAI code paths NOT intercepted by
# the class-level patch**:
#
#   1. ``OpenAICompletion`` structured output via the beta path:
#      ``self._client.beta.chat.completions.parse(...)`` and
#      ``self._client.beta.chat.completions.stream(...)``.
#      ``OpenAI.beta`` is a separate cached_property we do not patch.
#   2. Any future SDK resource that lands at a sibling
#      cached_property we have not added to the patch table (e.g.
#      ``Anthropic.completions`` legacy, ``OpenAI.audio``,
#      ``OpenAI.images``, etc -- deliberately excluded as
#      out-of-scope utility resources).
#
# The previously listed ``OpenAI.responses`` and
# ``Anthropic.beta.messages`` paths are now intercepted as of the
# Phase 3 patch extension; the tests
# ``test_openai_responses_intercepted`` and
# ``test_anthropic_beta_messages_intercepted`` below drive those
# paths against the live stack.
#
# These remaining gaps are documented architectural constraints,
# not bugs to defer to a KI. The class-level patching design is
# by-resource, not by-client. A symmetric note exists in
# ``ARCHITECTURE.md`` under "Framework limitations".


def test_crewai_native_openai_patched_intercepts_call(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """CrewAI's native OpenAICompletion is intercepted via patch().

    Default ``crewai.LLM(model="gpt-4o-mini")`` returns
    ``OpenAICompletion`` (not a litellm shim). The default ``call()``
    routes through ``self._client.chat.completions.create(...)``
    which the sensor's ``OpenAI.chat`` descriptor wraps as a
    ``SensorChat`` on first access. The resulting ``SensorCompletions
    .create`` runs the pre/post intercept and posts a ``post_call``
    event to the live DB.

    Verifies the same DB + fleet API contract as every other test in
    this file. Uses ``LLM.call(...)`` directly rather than building a
    full Agent/Task/Crew because the LLM call layer is what we are
    actually intercepting -- the agent/task/crew abstraction adds
    ~30 s of orchestration latency without exercising any additional
    sensor surface area.
    """
    flavor = unique_flavor

    os.environ["OPENAI_API_KEY"] = "test-key"
    try:
        with respx.mock(assert_all_called=False) as rmock:
            _mock_openai_with_latency(rmock)

            flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
            flightdeck_sensor.patch()

            from crewai import LLM

            llm = LLM(model="gpt-4o-mini")
            # Sanity check: verify we got the native provider, not a
            # litellm wrapper. If a future CrewAI release flips the
            # default to litellm, this assertion fails loudly so a
            # human investigates rather than silently losing coverage.
            assert type(llm).__module__.startswith("crewai.llms.providers"), (
                f"expected CrewAI native provider, got "
                f"{type(llm).__module__}.{type(llm).__name__} -- "
                f"if CrewAI changed its default routing this test "
                f"needs updating"
            )

            response = llm.call("Hello from CrewAI")
            assert response is not None

            _assert_full_pipeline_event_chain(flavor, "gpt-4o-mini")
            _assert_session_in_fleet_with_context(flavor)
    finally:
        os.environ.pop("OPENAI_API_KEY", None)


# ======================================================================
# Test 6 -- captured reference still intercepted after patch()
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


# ======================================================================
# Test 7 -- anthropic.beta.messages intercepted
# ======================================================================


# The Responses API and the Anthropic Messages response shape mock
# payloads live alongside the existing ANTHROPIC_RESPONSE /
# OPENAI_RESPONSE fixtures in test_sensor_e2e.py. We define the
# three new-resource payloads locally because they are specific to
# this file and only these three tests need them.

_ANTHROPIC_BETA_RESPONSE: dict[str, Any] = {
    "id": "msg_beta_test123",
    "type": "message",
    "role": "assistant",
    "content": [{"type": "text", "text": "Hello from mock Anthropic beta"}],
    "model": "claude-opus-4-6",
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 10, "output_tokens": 8},
}

_OPENAI_RESPONSES_RESPONSE: dict[str, Any] = {
    "id": "resp_test123",
    "object": "response",
    "created_at": 1234567890,
    "model": "gpt-4.1",
    "status": "completed",
    "error": None,
    "incomplete_details": None,
    "instructions": None,
    "max_output_tokens": None,
    "metadata": {},
    "parallel_tool_calls": True,
    "previous_response_id": None,
    "reasoning": {"effort": None, "summary": None},
    "service_tier": "default",
    "store": True,
    "temperature": 1.0,
    "text": {"format": {"type": "text"}},
    "tool_choice": "auto",
    "tools": [],
    "top_p": 1.0,
    "truncation": "disabled",
    "user": None,
    "output": [
        {
            "type": "message",
            "id": "msg_resp_test123",
            "status": "completed",
            "role": "assistant",
            "content": [
                {
                    "type": "output_text",
                    "text": "Hello from mock OpenAI responses",
                    "annotations": [],
                }
            ],
        }
    ],
    "output_text": "Hello from mock OpenAI responses",
    # Responses API uses input_tokens / output_tokens, NOT
    # prompt_tokens / completion_tokens. This exercises the fallback
    # path added to OpenAIProvider.extract_usage in this phase.
    "usage": {
        "input_tokens": 10,
        "input_tokens_details": {"cached_tokens": 0},
        "output_tokens": 8,
        "output_tokens_details": {"reasoning_tokens": 0},
        "total_tokens": 18,
    },
}

_OPENAI_EMBEDDINGS_RESPONSE: dict[str, Any] = {
    "object": "list",
    "model": "text-embedding-3-small",
    "data": [
        {
            "object": "embedding",
            "index": 0,
            "embedding": [0.1, 0.2, 0.3, 0.4],
        }
    ],
    # Embeddings carry prompt_tokens + total_tokens only. No
    # completion_tokens, no input_tokens/output_tokens. The existing
    # extract_usage chat path produces TokenUsage(prompt_tokens, 0)
    # which is semantically correct -- embeddings have no output
    # text to count.
    "usage": {"prompt_tokens": 10, "total_tokens": 10},
}


def _mock_anthropic_beta_with_latency(rmock: respx.MockRouter) -> None:
    """Mock the same /v1/messages route with the beta response body.

    The Anthropic beta Messages API POSTs to exactly the same URL
    (``https://api.anthropic.com/v1/messages``) as the top-level
    messages API -- the only wire-level difference is the
    ``anthropic-beta`` request header. respx ignores request headers
    by default, so matching only on method + URL is sufficient.
    """
    def _delayed(_request: httpx.Request) -> httpx.Response:
        time.sleep(0.05)
        return httpx.Response(200, json=_ANTHROPIC_BETA_RESPONSE)

    rmock.post("https://api.anthropic.com/v1/messages").mock(
        side_effect=_delayed
    )


def _mock_openai_responses_with_latency(rmock: respx.MockRouter) -> None:
    """Mock https://api.openai.com/v1/responses with 50 ms latency."""
    def _delayed(_request: httpx.Request) -> httpx.Response:
        time.sleep(0.05)
        return httpx.Response(200, json=_OPENAI_RESPONSES_RESPONSE)

    rmock.post("https://api.openai.com/v1/responses").mock(
        side_effect=_delayed
    )


def _mock_openai_embeddings_with_latency(rmock: respx.MockRouter) -> None:
    """Mock https://api.openai.com/v1/embeddings with 50 ms latency."""
    def _delayed(_request: httpx.Request) -> httpx.Response:
        time.sleep(0.05)
        return httpx.Response(200, json=_OPENAI_EMBEDDINGS_RESPONSE)

    rmock.post("https://api.openai.com/v1/embeddings").mock(
        side_effect=_delayed
    )


def test_anthropic_beta_messages_intercepted(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """``client.beta.messages.create()`` is intercepted via patch().

    The class-level patch installs
    :class:`_AnthropicMessagesDescriptor` on the ``Beta`` class's
    ``messages`` cached_property. On first access, the raw beta
    ``Messages`` resource is wrapped in :class:`SensorMessages` and
    the call goes through the sensor pre/post pipeline exactly like
    a top-level ``client.messages.create`` call.

    This path matters because Anthropic's Claude 4 family (Opus 4.6,
    Sonnet 4.6) uses the beta API for extended / adaptive thinking,
    which is no longer a niche beta feature -- it is an increasingly
    standard inference path.
    """
    flavor = unique_flavor

    with respx.mock(assert_all_called=False) as rmock:
        _mock_anthropic_beta_with_latency(rmock)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        flightdeck_sensor.patch()

        client = anthropic.Anthropic(api_key="test-key")
        response = client.beta.messages.create(
            model="claude-opus-4-6",
            messages=[{"role": "user", "content": "Hello"}],
            max_tokens=100,
        )
        assert response.id == "msg_beta_test123"

        _assert_full_pipeline_event_chain(flavor, "claude-opus-4-6")
        _assert_session_in_fleet_with_context(flavor)


# ======================================================================
# Test 8 -- openai.responses.create intercepted
# ======================================================================


def test_openai_responses_intercepted(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """``client.responses.create()`` is intercepted via patch().

    The Responses API (``OpenAI.responses``) is OpenAI's recommended
    entry point for all new projects as of March 2025; future
    features land here first. The class-level patch installs
    :class:`_OpenAIResponsesDescriptor` on ``OpenAI.responses``
    which wraps the raw ``Responses`` resource in
    :class:`SensorResponses` on first access.

    Also exercises the :meth:`OpenAIProvider.extract_usage` fallback
    that reads ``input_tokens`` / ``output_tokens`` when the chat
    shape (``prompt_tokens``/``completion_tokens``) is absent --
    without that fallback the ``post_call`` event would land with
    zero token counts.
    """
    flavor = unique_flavor

    with respx.mock(assert_all_called=False) as rmock:
        _mock_openai_responses_with_latency(rmock)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        flightdeck_sensor.patch()

        client = openai.OpenAI(api_key="test-key")
        response = client.responses.create(
            model="gpt-4.1",
            input="Hello from responses API",
        )
        assert response.id == "resp_test123"

        _assert_full_pipeline_event_chain(flavor, "gpt-4.1")
        _assert_session_in_fleet_with_context(flavor)


# ======================================================================
# Test 9 -- openai.embeddings.create intercepted
# ======================================================================


def test_openai_embeddings_intercepted(
    sensor_reset: None, unique_flavor: str,
) -> None:
    """``client.embeddings.create()`` is intercepted via patch().

    Embeddings are common in RAG-heavy agent pipelines, so counting
    their tokens is relevant for full agent-workflow accounting. The
    class-level patch installs :class:`_OpenAIEmbeddingsDescriptor`
    on ``OpenAI.embeddings`` which wraps the raw ``Embeddings``
    resource in :class:`SensorEmbeddings` on first access.

    Embeddings responses carry only ``usage.prompt_tokens`` and
    ``usage.total_tokens`` -- there is no output text to count, so
    the ``post_call`` ``tokens_output`` is expected to be zero. This
    test therefore does NOT use
    :func:`_assert_full_pipeline_event_chain` (which strictly asserts
    the 10/8/18 chat shape) and instead verifies the subset of
    fields available for embeddings: a ``post_call`` exists, its
    ``model`` is set, and ``tokens_input`` matches the mock
    ``prompt_tokens``.
    """
    flavor = unique_flavor

    with respx.mock(assert_all_called=False) as rmock:
        _mock_openai_embeddings_with_latency(rmock)

        flightdeck_sensor.init(server=INGESTION_URL, token=TOKEN)
        flightdeck_sensor.patch()

        client = openai.OpenAI(api_key="test-key")
        response = client.embeddings.create(
            model="text-embedding-3-small",
            input="Hello from embeddings",
        )
        # The SDK returns a CreateEmbeddingResponse; we just need
        # some basic shape confirmation -- the DB events are the
        # interception proof.
        assert response.model == "text-embedding-3-small"
        assert len(response.data) == 1

        # Verify session_start + post_call land in the DB, with
        # model present and tokens_input = 10 (prompt_tokens).
        # tokens_output = 0 is expected for embeddings, not a bug.
        _wait_for_event_type(flavor, "session_start", timeout=10)
        post_call = _wait_for_event_type(flavor, "post_call", timeout=15)
        assert post_call.get("model") == "text-embedding-3-small", (
            f"post_call model missing: {post_call}"
        )
        assert post_call["tokens_input"] == 10, (
            f"expected tokens_input=10, got {post_call.get('tokens_input')}"
        )
        assert post_call["tokens_output"] == 0, (
            f"expected tokens_output=0 for embeddings, "
            f"got {post_call.get('tokens_output')}"
        )

        _assert_session_in_fleet_with_context(flavor)
