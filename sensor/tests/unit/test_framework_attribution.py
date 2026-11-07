"""Per-event framework attribution.

Guarded regression: ``Session.record_framework`` had zero callers, so every event
emitted ``framework=null`` and the dashboard's FRAMEWORK facet,
analytics group_by, and ``/v1/sessions?framework=`` filter were all
silently broken. The fix wires
``flightdeck_sensor.__init__.init`` → ``Session.record_framework``
through ``FrameworkCollector``'s first detected entry, with the
``/<version>`` suffix stripped so per-event analytics use the bare
dimension (``langchain``).

Tests in this file pin three facets of the contract:

* The bare-name strip works for versioned and unversioned classifier
  outputs.
* When ``FrameworkCollector`` returns nothing,
  ``session._framework`` stays ``None`` (no behaviour change for
  bare-SDK users).
* ``Session.record_framework`` is actually called and the value
  threads into the per-event payload via ``post_call_event``.
"""

from __future__ import annotations

import os
import sys
import types
from typing import Any
from unittest.mock import MagicMock

import pytest

import flightdeck_sensor as fd


class _FrameworkModules:
    """The module table as the framework classifiers read it: the real
    ``sys.modules``, except that a framework module a classifier looks
    for is found only when the test installed it."""

    def __init__(self, framework_names: frozenset[str], installed: dict[str, Any]) -> None:
        self._framework_names = framework_names
        self._installed = installed

    def get(self, name: str, default: Any = None) -> Any:
        if name in self._framework_names:
            return self._installed.get(name, default)
        return sys.modules.get(name, default)

    def __len__(self) -> int:
        # Installing a framework module grows the table, as an import
        # does: the late detection runs the classifiers again only then.
        return len(sys.modules) + len(self._installed)


@pytest.fixture(autouse=True)
def frameworks(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """The framework modules this test installs, keyed by module name.
    The classifiers see only these, never a real framework that an
    earlier test (or a background thread one left running) imported
    into the same worker: a loaded ``crewai`` would outrank a faked
    ``langchain``, and importing any ``crewai`` submodule re-adds the
    package to ``sys.modules`` behind a test's back. No distribution
    counts as installed, so a version comes from the fake module."""
    from flightdeck_sensor.core import context
    from flightdeck_sensor.core.context import FrameworkCollector

    names: set[str] = set()
    for classifier in FrameworkCollector.CLASSIFIERS:
        module = classifier.module
        names.update((module,) if isinstance(module, str) else module)
    installed: dict[str, Any] = {}
    view = types.SimpleNamespace(
        argv=sys.argv, modules=_FrameworkModules(frozenset(names), installed)
    )
    monkeypatch.setattr(context, "sys", view)
    monkeypatch.setattr(context, "_distribution_version", lambda _name: None)
    return installed


def _fake_module(name: str, version: str | None = None) -> types.ModuleType:
    mod = types.ModuleType(name)
    if version is not None:
        mod.__version__ = version  # type: ignore[attr-defined]
    return mod


def _init() -> Any:
    fd.init(
        server="http://localhost:4000/ingest",
        token="tok_dev",
        agent_type="production",
        quiet=True,
    )
    assert fd._session is not None
    return fd._session


def _reset_sensor() -> None:
    """Hard reset between tests so ``init()``'s
    ``if _session is not None: return`` short-circuit doesn't leak
    state from one test into the next.
    """
    fd.teardown()


@pytest.fixture(autouse=True)
def _isolate_env() -> Any:
    """Prevent FLIGHTDECK_* env from poisoning these tests.
    feedback_env_leak_release.md: leaked env vars from ``make dev``
    have caused empty-server tests to misfire."""
    saved = {}
    for k in list(os.environ):
        if k.startswith("FLIGHTDECK_") or k == "AGENT_FLAVOR":
            saved[k] = os.environ.pop(k)
    yield
    for k, v in saved.items():
        os.environ[k] = v
    _reset_sensor()


def test_init_strips_version_suffix_and_records_bare_framework(
    frameworks: dict[str, Any],
) -> None:
    """``langchain/0.3.x`` from FrameworkCollector lands as bare
    ``langchain`` on the session's per-event ``framework`` field."""
    _reset_sensor()
    fake_lc = MagicMock()
    fake_lc.__version__ = "0.3.27"
    frameworks["langchain"] = fake_lc

    fd.init(
        server="http://localhost:4000/ingest",
        token="tok_dev",
        agent_type="production",
        quiet=True,
    )
    assert fd._session is not None
    # Versioned form lives in context for diagnostic detail.
    frameworks_ctx = fd._session._context.get("frameworks") or []
    assert any(f.startswith("langchain/") for f in frameworks_ctx)
    # Bare form lives on the session for the per-event payload.
    assert fd._session._framework == "langchain"


def test_init_no_framework_keeps_session_framework_none() -> None:
    """When FrameworkCollector finds nothing the session's framework
    stays ``None`` -- bare-SDK users don't get spurious attribution."""
    _reset_sensor()
    fd.init(
        server="http://localhost:4000/ingest",
        token="tok_dev",
        agent_type="production",
        quiet=True,
    )
    assert fd._session is not None
    assert fd._session._framework is None


def test_init_strips_unversioned_classifier_output(
    frameworks: dict[str, Any],
) -> None:
    """A classifier returning the bare name (no ``__version__``)
    lands the same value on the session."""
    _reset_sensor()
    fake = MagicMock(spec=[])  # spec=[] → no __version__ attribute
    frameworks["crewai"] = fake

    fd.init(
        server="http://localhost:4000/ingest",
        token="tok_dev",
        agent_type="production",
        quiet=True,
    )
    assert fd._session is not None
    assert fd._session._framework == "crewai"


def test_init_picks_first_classifier_match(
    frameworks: dict[str, Any],
) -> None:
    """When multiple frameworks are present the per-event field uses
    the first match in FrameworkCollector's classifier order, where a
    framework comes before the ones it is built on: LangGraph before
    LangChain."""
    _reset_sensor()
    lc = MagicMock()
    lc.__version__ = "0.3.27"
    lg = MagicMock()
    lg.__version__ = "0.2.50"
    frameworks["langchain"] = lc
    frameworks["langgraph"] = lg

    fd.init(
        server="http://localhost:4000/ingest",
        token="tok_dev",
        agent_type="production",
        quiet=True,
    )
    assert fd._session is not None
    # LangGraph comes before LangChain in the classifier list -- that
    # ordering is the contract this test pins. The two are listed in
    # context.frameworks[] in classifier order; the bare per-event
    # value is the first one.
    assert fd._session._framework == "langgraph"
    assert fd._session._context["frameworks"] == ["langgraph/0.2.50", "langchain/0.3.27"]


def test_post_call_event_carries_framework(
    frameworks: dict[str, Any],
) -> None:
    """End-to-end: a recorded framework lands on every emitted
    event payload. Mocks the transport to inspect the payload
    enqueued for drain rather than going to a live server."""
    _reset_sensor()
    fake_lc = MagicMock()
    fake_lc.__version__ = "0.3.27"
    frameworks["langchain"] = fake_lc

    fd.init(
        server="http://localhost:4000/ingest",
        token="tok_dev",
        agent_type="production",
        quiet=True,
    )
    assert fd._session is not None
    # Patch event_queue.enqueue so we can inspect what would be
    # posted without exercising the transport. The session_start
    # event has already been enqueued by init() but we don't care --
    # we want to see that subsequent events also pick up the
    # framework. Build a payload via _build_payload and check.
    from flightdeck_sensor.core.types import EventType

    payload = fd._session._build_payload(EventType.POST_CALL, model="x")
    assert payload["framework"] == "langchain"


# ----------------------------------------------------------------------
# A framework imported after init()
# ----------------------------------------------------------------------


def test_a_framework_imported_before_init_labels_the_first_event(
    frameworks: dict[str, Any],
) -> None:
    """Import, then init(): the classifiers find the framework at init()
    and every event, the session_start included, carries its label."""
    _reset_sensor()
    frameworks["pydantic_ai"] = _fake_module("pydantic_ai", "2.64.0")
    session = _init()

    from flightdeck_sensor.core.types import EventType

    assert session._framework == "pydantic_ai"
    assert session._context["frameworks"] == ["pydantic_ai/2.64.0"]
    assert session._build_payload(EventType.POST_CALL)["framework"] == "pydantic_ai"


def test_a_framework_imported_after_init_labels_the_next_event(
    frameworks: dict[str, Any],
) -> None:
    """init(), then import: patch() imports nothing, so the framework is
    not loaded at init(). The next event built finds it, and every event
    after carries the label; the versioned entry reaches the context that
    a sub-agent's session_start inherits."""
    _reset_sensor()
    session = _init()

    from flightdeck_sensor.core.types import EventType

    assert session._framework is None
    assert session._build_payload(EventType.POST_CALL)["framework"] is None

    frameworks["agno"] = _fake_module("agno", "2.1.0")

    assert session._build_payload(EventType.POST_CALL)["framework"] == "agno"
    assert session._build_payload(EventType.TOOL_CALL)["framework"] == "agno"
    assert session._context["frameworks"] == ["agno/2.1.0"]
    child = session._build_subagent_payload(
        event_type=EventType.SESSION_START,
        child_session_id="33333333-3333-3333-3333-333333333333",
        child_agent_id="44444444-4444-4444-4444-444444444444",
        child_agent_name="child",
        agent_role="researcher",
    )
    assert child["framework"] == "agno"
    assert child["context"]["frameworks"] == ["agno/2.1.0"]


def test_a_framework_imported_after_init_is_found_by_a_sub_agent_start(
    frameworks: dict[str, Any],
) -> None:
    """The first event built after the import may be a sub-agent's
    session_start; it carries the label too."""
    _reset_sensor()
    session = _init()
    frameworks["crewai"] = _fake_module("crewai", "1.15.0")

    from flightdeck_sensor.core.types import EventType

    child = session._build_subagent_payload(
        event_type=EventType.SESSION_START,
        child_session_id="33333333-3333-3333-3333-333333333333",
        child_agent_id="44444444-4444-4444-4444-444444444444",
        child_agent_name="child",
        agent_role="researcher",
    )
    assert child["framework"] == "crewai"


def test_late_detection_scans_only_while_the_label_is_unknown_and_modules_change(
    frameworks: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """The classifiers run again only when the module table has grown,
    and never once a label resolved: an event costs no module scan after
    the framework is known."""
    from flightdeck_sensor.core import context
    from flightdeck_sensor.core.types import EventType

    _reset_sensor()
    session = _init()
    calls: list[int] = []
    real = context.detect_frameworks

    def counting() -> list[str]:
        calls.append(1)
        return real()

    monkeypatch.setattr(context, "detect_frameworks", counting)

    session._build_payload(EventType.POST_CALL)
    session._build_payload(EventType.POST_CALL)
    assert calls == [], "nothing imported since the last scan: no scan"

    frameworks["unrelated_module"] = _fake_module("unrelated_module")
    session._build_payload(EventType.POST_CALL)
    assert len(calls) == 1, "the module table grew: one scan"
    assert session._framework is None

    frameworks["strands"] = _fake_module("strands")
    session._build_payload(EventType.POST_CALL)
    assert session._framework == "strands"
    scans = len(calls)

    frameworks["langchain"] = _fake_module("langchain", "1.4.4")
    for _ in range(3):
        assert session._build_payload(EventType.POST_CALL)["framework"] == "strands"
    assert len(calls) == scans, "the label resolved: no more scans"


def test_late_detection_is_skipped_on_a_signals_shutdown_path(
    frameworks: dict[str, Any],
) -> None:
    """A signal's shutdown builds session_end with a bounded lock wait,
    and nothing on that path may load a module, so it never scans."""
    from flightdeck_sensor.core.types import EventType

    _reset_sensor()
    session = _init()
    frameworks["dspy"] = _fake_module("dspy", "3.4.0")

    payload = session._build_payload(EventType.SESSION_END, lock_wait=0.5)
    assert payload["framework"] is None
    assert session._build_payload(EventType.POST_CALL)["framework"] == "dspy"


def test_a_failing_late_scan_leaves_the_event_unlabelled(
    frameworks: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Attribution is best-effort: a scan that raises builds the event
    with a null framework."""
    from flightdeck_sensor.core import context
    from flightdeck_sensor.core.types import EventType

    _reset_sensor()
    session = _init()

    def broken() -> list[str]:
        raise RuntimeError("boom")

    monkeypatch.setattr(context, "detect_frameworks", broken)
    frameworks["agno"] = _fake_module("agno")

    assert session._build_payload(EventType.POST_CALL)["framework"] is None
