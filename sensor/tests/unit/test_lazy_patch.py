"""patch() patches each SDK when the application first imports it.

``import flightdeck_sensor``, ``init()`` and ``patch()`` import no SDK
(and so litellm does not fetch its price list); an SDK imported later is
patched as it is imported and its calls are metered, as is one imported
first, as before. The subprocess tests observe a fresh interpreter with
the real SDKs; the in-process ones drive patch() and unpatch() against a
stand-in SDK module.
"""

from __future__ import annotations

import importlib
import importlib.util
import json
import sys
import threading
import types
import uuid
from typing import TYPE_CHECKING, Any
from unittest.mock import MagicMock

import pytest

import flightdeck_sensor
from flightdeck_sensor import Provider
from tests.unit._child_process import CaptureServer, child_env, finish, start_child

if TYPE_CHECKING:
    from pathlib import Path

# The SDK modules whose import triggers a patch, as _SDK_TARGETS names them.
SDK_MODULES = (
    "anthropic",
    "openai",
    "litellm",
    "mcp",
    "crewai",
    "langgraph.graph",
    "claude_agent_sdk",
)
# Bound for the in-process waits on another thread.
THREAD_WAIT_SECS = 10.0
# Time given to patch() on another thread to reach an import in progress
# before the test lets that import finish.
PATCH_HEAD_START_SECS = 0.2


def _installed(module: str) -> bool:
    """Whether ``module``'s distribution is installed, without importing
    the module (only its top-level package is looked up)."""
    return importlib.util.find_spec(module.split(".")[0]) is not None


def _run_child(
    sdk: str, order: str, *, local_price_list: bool = True
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Run the child for ``sdk`` / ``order`` against a capture server and
    return its report and the events of its session (sub-agent ones
    included)."""
    with CaptureServer() as capture:
        env = child_env(
            ANTHROPIC_BASE_URL=capture.url,
            ANTHROPIC_API_KEY="test-key",
            OPENAI_BASE_URL=f"{capture.url}/v1",
            OPENAI_API_KEY="test-key",
        )
        if local_price_list:
            env["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
        proc = start_child("_lazy_patch_child.py", capture.url, sdk, order, env=env)
        code, out, err = finish(proc)
        assert code == 0, (code, out, err)
        report: dict[str, Any] = json.loads(out.strip().splitlines()[-1])
        session_id = report["session_id"]
        with capture._lock:
            events = [
                e
                for e in capture.events
                if session_id in (e.get("session_id"), e.get("parent_session_id"))
            ]
    return report, events


def _assert_metered(sdk: str, session_id: str, events: list[dict[str, Any]]) -> None:
    """The one call the child made through ``sdk`` reached the capture
    server as the sensor reports it."""
    if sdk in ("openai", "anthropic", "litellm"):
        post_calls = [e for e in events if e["event_type"] == "post_call"]
        assert len(post_calls) == 1, events
        assert (post_calls[0]["tokens_input"], post_calls[0]["tokens_output"]) == (7, 3)
    elif sdk == "mcp":
        calls = [e for e in events if e["event_type"] == "mcp_tool_call"]
        assert [c["tool_name"] for c in calls] == ["echo"], events
    elif sdk == "langgraph.graph":
        children = [
            e
            for e in events
            if e["event_type"] == "session_start" and e.get("parent_session_id") == session_id
        ]
        assert [c.get("agent_role") for c in children] == ["worker"], events


# ----------------------------------------------------------------------
# A fresh interpreter with the real SDKs
# ----------------------------------------------------------------------


def test_import_init_and_patch_load_no_sdk() -> None:
    report, events = _run_child("none", "after")
    assert report["loaded_after_patch"] == []
    assert report["network"] == []
    assert [e["event_type"] for e in events] == ["session_start", "session_end"]


@pytest.mark.parametrize("order", ["after", "before"])
@pytest.mark.parametrize("sdk", SDK_MODULES)
def test_an_sdk_is_patched_and_metered_whichever_is_imported_first(sdk: str, order: str) -> None:
    if not _installed(sdk):
        pytest.skip(f"{sdk} is not installed in this lane")
    report, events = _run_child(sdk, order)
    if order == "after":
        # Nothing was loaded until the application imported the SDK.
        assert report["loaded_after_patch"] == []
    else:
        assert sdk in report["loaded_after_patch"]
    assert report["patched"] is True
    assert report["network"] == []
    _assert_metered(sdk, report["session_id"], events)


@pytest.mark.parametrize("sdk", ["anthropic", "openai", "litellm", "mcp"])
def test_a_reloaded_sdk_stays_patched(sdk: str) -> None:
    if not _installed(sdk):
        pytest.skip(f"{sdk} is not installed in this lane")
    report, events = _run_child(sdk, "reload")
    assert report["patched"] is True
    _assert_metered(sdk, report["session_id"], events)


@pytest.mark.skipif(not _installed("litellm"), reason="litellm is not installed in this lane")
def test_litellm_fetches_its_price_list_only_when_the_application_imports_it() -> None:
    report, _events = _run_child("litellm", "after", local_price_list=False)
    # No fetch through import, init() and patch(); litellm's own import
    # then tries it (and is refused), which shows the guard sees it.
    assert report["price_fetch_at_patch"] is False
    assert "raw.githubusercontent.com" in report["network"]
    assert report["patched"] is True


# ----------------------------------------------------------------------
# patch() and unpatch() against a stand-in SDK, in process
# ----------------------------------------------------------------------


@pytest.fixture()
def fake_sdk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    """A module standing in for an SDK, importable but not imported, and
    an interceptor module for it registered as
    ``flightdeck_sensor.interceptor.<name>`` that records its patch and
    unpatch calls. ``_SDK_TARGETS`` holds only its target."""
    name = f"fd_fake_sdk_{uuid.uuid4().hex[:10]}"
    gate = f"{name}_gate"
    (tmp_path / f"{gate}.py").write_text(
        "import threading\nENTERED = threading.Event()\nRELEASE = threading.Event()\nWAIT = False\n"
    )
    (tmp_path / f"{name}.py").write_text(
        f"import {gate}\nif {gate}.WAIT:\n    {gate}.ENTERED.set()\n"
        f"    {gate}.RELEASE.wait({THREAD_WAIT_SECS})\nLOADED = True\n"
    )
    monkeypatch.syspath_prepend(str(tmp_path))
    calls: list[tuple[str, ...]] = []

    interceptor = types.ModuleType(f"flightdeck_sensor.interceptor.{name}")

    def patch_fake(quiet: bool = False) -> None:
        assert sys.modules[name].LOADED  # patched only once its code has run
        calls.append(("patch", str(quiet)))

    def unpatch_fake() -> None:
        calls.append(("unpatch",))

    interceptor.patch_fake = patch_fake  # type: ignore[attr-defined]
    interceptor.unpatch_fake = unpatch_fake  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, interceptor.__name__, interceptor)
    target = flightdeck_sensor._SDKTarget(
        Provider.ANTHROPIC, name, name, "patch_fake", "unpatch_fake"
    )
    monkeypatch.setattr(flightdeck_sensor, "_SDK_TARGETS", (target,))
    monkeypatch.setattr(flightdeck_sensor, "_session", MagicMock())
    try:
        yield types.SimpleNamespace(name=name, gate=gate, calls=calls)
    finally:
        flightdeck_sensor.unpatch()
        for module in (name, gate):
            sys.modules.pop(module, None)


def _patch() -> None:
    flightdeck_sensor.patch(quiet=True, providers=[Provider.ANTHROPIC])


def test_patch_leaves_an_sdk_that_is_not_imported_alone_until_it_is(fake_sdk: Any) -> None:
    _patch()
    assert fake_sdk.name not in sys.modules
    assert fake_sdk.calls == []
    importlib.import_module(fake_sdk.name)
    assert fake_sdk.calls == [("patch", "True")]
    importlib.import_module(fake_sdk.name)
    assert fake_sdk.calls == [("patch", "True")]


def test_an_sdk_imported_first_is_patched_at_once(fake_sdk: Any) -> None:
    importlib.import_module(fake_sdk.name)
    _patch()
    assert fake_sdk.calls == [("patch", "True")]


def test_unpatch_unpatches_and_stops_patching_on_import(fake_sdk: Any) -> None:
    _patch()
    importlib.import_module(fake_sdk.name)
    flightdeck_sensor.unpatch()
    assert fake_sdk.calls == [("patch", "True"), ("unpatch",)]
    assert not any(getattr(f, "_flightdeck_import_hook", False) is True for f in sys.meta_path)
    importlib.reload(sys.modules[fake_sdk.name])
    assert fake_sdk.calls == [("patch", "True"), ("unpatch",)]


def test_unpatch_leaves_an_sdk_that_was_never_imported_alone(fake_sdk: Any) -> None:
    _patch()
    flightdeck_sensor.unpatch()
    assert fake_sdk.calls == []
    assert fake_sdk.name not in sys.modules


def test_the_import_hook_never_waits_for_the_patch_lock(fake_sdk: Any) -> None:
    _patch()
    # As when patch() or unpatch() runs on another thread: the import goes
    # through without waiting, and the patch is applied by whoever holds
    # the lock once it is free.
    with flightdeck_sensor._patch_lock:
        importlib.import_module(fake_sdk.name)
        assert fake_sdk.calls == []
    flightdeck_sensor._patch_pending()
    assert fake_sdk.calls == [("patch", "True")]


def test_patch_waits_for_an_import_another_thread_started(fake_sdk: Any) -> None:
    gate = importlib.import_module(fake_sdk.gate)
    gate.WAIT = True
    # The import starts before patch() is called, so no hook sees it:
    # patch() has to wait for it and patch the SDK itself.
    importer = threading.Thread(target=importlib.import_module, args=(fake_sdk.name,))
    importer.start()
    assert gate.ENTERED.wait(THREAD_WAIT_SECS)
    patcher = threading.Thread(target=_patch)
    patcher.start()
    # Give patch() time to reach the import in progress: one that did not
    # wait for it would skip the SDK, and nothing would patch it later.
    patcher.join(PATCH_HEAD_START_SECS)
    gate.RELEASE.set()
    importer.join(THREAD_WAIT_SECS)
    patcher.join(THREAD_WAIT_SECS)
    assert fake_sdk.calls == [("patch", "True")]


def test_concurrent_first_imports_patch_once(fake_sdk: Any) -> None:
    _patch()
    barrier = threading.Barrier(8)

    def import_it() -> None:
        barrier.wait(THREAD_WAIT_SECS)
        importlib.import_module(fake_sdk.name)

    threads = [threading.Thread(target=import_it) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(THREAD_WAIT_SECS)
    assert fake_sdk.calls == [("patch", "True")]


def test_a_failing_patch_on_import_does_not_break_the_import(
    fake_sdk: Any, caplog: pytest.LogCaptureFixture
) -> None:
    def broken(quiet: bool = False) -> None:
        raise RuntimeError("layout changed")

    sys.modules[f"flightdeck_sensor.interceptor.{fake_sdk.name}"].patch_fake = broken
    _patch()
    module = importlib.import_module(fake_sdk.name)
    assert module.LOADED is True
    assert f"patching {fake_sdk.name} failed" in caplog.text


# ----------------------------------------------------------------------
# The target table and the package's lazy names
# ----------------------------------------------------------------------


def test_every_provider_has_one_patch_target() -> None:
    providers = [t.provider for t in flightdeck_sensor._SDK_TARGETS]
    assert sorted(providers) == sorted(Provider)
    assert tuple(t.module for t in flightdeck_sensor._SDK_TARGETS) == SDK_MODULES


def test_names_from_interceptor_modules_resolve_on_first_access() -> None:
    from flightdeck_sensor.interceptor import litellm, openai

    assert flightdeck_sensor.SensorLitellm is litellm.SensorLitellm
    assert flightdeck_sensor.patch_openai_classes is openai.patch_openai_classes
    from flightdeck_sensor import SensorOpenAI

    assert SensorOpenAI is openai.SensorOpenAI
    with pytest.raises(AttributeError):
        _ = flightdeck_sensor.no_such_name
