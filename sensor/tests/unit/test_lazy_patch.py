"""patch() patches each SDK when the application first imports it.

``import flightdeck_sensor``, ``init()`` and ``patch()`` import no SDK
(and so litellm does not fetch its price list); an SDK imported later is
patched as it is imported and its calls are metered, as is one imported
first, as before. The subprocess tests observe a fresh interpreter with
the real SDKs; the in-process ones drive patch() and unpatch() against a
stand-in SDK module.
"""

from __future__ import annotations

import ast
import importlib
import importlib.util
import json
import sys
import threading
import types
import uuid
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest

import flightdeck_sensor
from flightdeck_sensor import Provider
from tests.unit._child_process import (
    CAPTURE_TOOL_NAME,
    CaptureServer,
    child_env,
    finish,
    start_child,
)

# The SDK modules whose import triggers a patch, as _SDK_TARGETS names them.
SDK_MODULES = (
    "anthropic",
    "openai",
    "litellm",
    "mcp",
    "crewai",
    "langgraph.graph",
    "llama_index.core",
    "claude_agent_sdk",
)
# Bound for the in-process waits on another thread.
THREAD_WAIT_SECS = 10.0
# Time given to patch() on another thread to reach an import in progress
# before the test lets that import finish.
PATCH_HEAD_START_SECS = 0.2
# The host tiktoken downloads an encoding from the first time the sensor
# estimates an OpenAI call's tokens, unless its cache, shared by every
# process on the machine, already holds it (whether another test filled
# it first depends on the order the tests run in). A fetch the call makes,
# not an import; the child refuses it like any other, and the estimate
# falls back to a heuristic.
TIKTOKEN_ENCODINGS_HOST = "openaipublic.blob.core.windows.net"


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
    elif sdk == "llama_index.core":
        children = [
            e
            for e in events
            if e["event_type"] == "session_start" and e.get("parent_session_id") == session_id
        ]
        assert [c.get("agent_role") for c in children] == ["worker"], events
        (child,) = children
        calls = [e for e in events if e["event_type"] == "post_call"]
        assert [c["session_id"] for c in calls] == [child["session_id"]], events


# ----------------------------------------------------------------------
# A fresh interpreter with the real SDKs
# ----------------------------------------------------------------------


def test_import_init_and_patch_load_no_sdk() -> None:
    report, events = _run_child("none", "after")
    assert report["loaded_after_patch"] == []
    assert report["network"] == []
    assert [e["event_type"] for e in events] == ["session_start", "session_end"]


# "interceptor" imports the sensor's interceptor module for the SDK first
# (as the sensor's own emission paths and an application reading a
# ``patch_*`` name can), so the SDK's first import happens inside it.
@pytest.mark.parametrize("order", ["after", "before", "interceptor"])
@pytest.mark.parametrize("sdk", SDK_MODULES)
def test_an_sdk_is_patched_and_metered_whichever_is_imported_first(sdk: str, order: str) -> None:
    if not _installed(sdk):
        pytest.skip(f"{sdk} is not installed in this lane")
    report, events = _run_child(sdk, order)
    if order != "before":
        # Nothing was loaded until the application imported the SDK.
        assert report["loaded_after_patch"] == []
    else:
        assert sdk in report["loaded_after_patch"]
    assert report["patched"] is True
    # Nothing left the machine through the imports, init() and patch(),
    # nor through the call but for tiktoken's encodings.
    assert report["network_at_patch"] == []
    assert [h for h in report["network"] if h != TIKTOKEN_ENCODINGS_HOST] == []
    _assert_metered(sdk, report["session_id"], events)


@pytest.mark.parametrize("sdk", ["anthropic", "openai", "litellm", "mcp"])
def test_a_reloaded_sdk_stays_patched(sdk: str) -> None:
    if not _installed(sdk):
        pytest.skip(f"{sdk} is not installed in this lane")
    report, events = _run_child(sdk, "reload")
    assert report["patched"] is True
    _assert_metered(sdk, report["session_id"], events)


@pytest.mark.skipif(
    not (_installed("openai") and _installed("mcp")),
    reason="openai and mcp are not both installed in this lane",
)
def test_a_captured_llm_tool_call_imports_no_other_sdk() -> None:
    # The tool_call's captured arguments are built without the MCP
    # interceptor, whose import would import mcp into an application that
    # never did, inside its LLM call.
    report, events = _run_child("openai", "tool_call")
    assert report["patched"] is True
    assert report["loaded_at_end"] == ["openai"]
    tool_calls = [e for e in events if e["event_type"] == "tool_call"]
    assert [t["tool_name"] for t in tool_calls] == [CAPTURE_TOOL_NAME], events
    assert tool_calls[0]["has_content"] is True
    assert tool_calls[0]["content"]["tool_input"] == {"city": "Paris"}


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


# An interceptor module for the on-disk stand-in SDK: it imports the SDK
# at its top, as every real one does, patches idempotently, as every real
# one does, and records its calls on it. With its gate's WAIT set, it
# signals ENTERED and holds its import until RELEASE.
_INTERCEPTOR_SOURCE = """\
import {gate}

if {gate}.WAIT:
    {gate}.ENTERED.set()
    {gate}.RELEASE.wait({wait})

import {sdk}


def patch_fake(quiet=False):
    if getattr({sdk}, "PATCHED", False):
        return
    {sdk}.PATCHED = True
    {sdk}.CALLS.append(("patch", str(quiet)))


def unpatch_fake():
    {sdk}.PATCHED = False
    {sdk}.CALLS.append(("unpatch",))
"""
# One that defines its patch before it imports the SDK, and binds a name
# the patch uses only after: patched before its code ends, it would fail.
_LATE_BINDING_INTERCEPTOR_SOURCE = """\
def patch_fake(quiet=False):
    {sdk}.CALLS.append(("patch", _LABEL))


def unpatch_fake():
    pass


import {sdk}

_LABEL = "whole"
"""
# One that does not import the SDK.
_SDK_FREE_INTERCEPTOR_SOURCE = """\
def patch_fake(quiet=False):
    raise AssertionError("patched an SDK that is not imported")


def unpatch_fake():
    pass
"""


@pytest.fixture()
def fake_sdk_on_disk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Any:
    """A stand-in SDK and a real interceptor module for it, both files on
    disk and neither imported, with ``_SDK_TARGETS`` holding only their
    target. ``write(source)`` writes the interceptor module."""
    name = f"fd_fake_sdk_{uuid.uuid4().hex[:10]}"
    interceptor = f"{name}_interceptor"
    module_name = f"flightdeck_sensor.interceptor.{interceptor}"
    sdk_dir = tmp_path / "sdk"
    interceptor_dir = tmp_path / "interceptor"
    sdk_dir.mkdir()
    interceptor_dir.mkdir()
    gate = f"{name}_gate"
    (sdk_dir / f"{name}.py").write_text("CALLS = []\n")
    (sdk_dir / f"{gate}.py").write_text(
        "import threading\nENTERED = threading.Event()\nRELEASE = threading.Event()\nWAIT = False\n"
    )
    monkeypatch.syspath_prepend(str(sdk_dir))
    package = sys.modules["flightdeck_sensor.interceptor"]
    monkeypatch.setattr(package, "__path__", [*package.__path__, str(interceptor_dir)])
    target = flightdeck_sensor._SDKTarget(
        Provider.ANTHROPIC, name, interceptor, "patch_fake", "unpatch_fake"
    )
    monkeypatch.setattr(flightdeck_sensor, "_SDK_TARGETS", (target,))
    monkeypatch.setattr(flightdeck_sensor, "_session", MagicMock())

    def write(source: str) -> None:
        (interceptor_dir / f"{interceptor}.py").write_text(
            source.format(sdk=name, gate=gate, wait=THREAD_WAIT_SECS)
        )

    try:
        yield types.SimpleNamespace(
            name=name, gate=gate, interceptor=interceptor, module=module_name, write=write
        )
    finally:
        flightdeck_sensor.unpatch()
        for module in (name, gate, module_name):
            sys.modules.pop(module, None)
        if hasattr(package, interceptor):
            delattr(package, interceptor)


def test_an_sdk_first_imported_by_its_interceptor_module_is_patched(
    fake_sdk_on_disk: Any, caplog: pytest.LogCaptureFixture
) -> None:
    fake_sdk_on_disk.write(_INTERCEPTOR_SOURCE)
    _patch()
    # The SDK finishes importing while the interceptor module is still
    # executing and has not defined its patch: the patch waits for the
    # end of that module's import instead of failing on a half-built one.
    importlib.import_module(fake_sdk_on_disk.module)
    assert sys.modules[fake_sdk_on_disk.name].CALLS == [("patch", "True")]
    assert "failed" not in caplog.text


def test_the_sensor_reaching_for_an_interceptor_first_finds_its_sdk_patched(
    fake_sdk_on_disk: Any, caplog: pytest.LogCaptureFixture
) -> None:
    # As a package lazy name or an emission path does: the interceptor
    # module comes back whole, and the SDK its import imported is patched.
    fake_sdk_on_disk.write(_INTERCEPTOR_SOURCE)
    _patch()
    module = flightdeck_sensor._interceptor(fake_sdk_on_disk.interceptor)
    assert callable(module.patch_fake)
    assert sys.modules[fake_sdk_on_disk.name].CALLS == [("patch", "True")]
    assert "failed" not in caplog.text


def test_an_interceptor_module_imported_without_its_sdk_patches_nothing(
    fake_sdk_on_disk: Any,
) -> None:
    fake_sdk_on_disk.write(_SDK_FREE_INTERCEPTOR_SOURCE)
    _patch()
    importlib.import_module(fake_sdk_on_disk.module)
    assert fake_sdk_on_disk.name not in sys.modules


def test_an_interceptor_module_is_patched_from_only_once_its_code_has_run(
    fake_sdk_on_disk: Any, caplog: pytest.LogCaptureFixture
) -> None:
    # Its patch function exists when its import of the SDK ends, but a
    # name the patch needs does not yet: the patch waits for the module's
    # last line, not for the function to be defined.
    fake_sdk_on_disk.write(_LATE_BINDING_INTERCEPTOR_SOURCE)
    _patch()
    importlib.import_module(fake_sdk_on_disk.module)
    assert sys.modules[fake_sdk_on_disk.name].CALLS == [("patch", "whole")]
    assert "failed" not in caplog.text


def test_patch_waits_for_an_interceptor_import_another_thread_started(
    fake_sdk_on_disk: Any,
) -> None:
    fake_sdk_on_disk.write(_INTERCEPTOR_SOURCE)
    gate = importlib.import_module(fake_sdk_on_disk.gate)
    gate.WAIT = True
    # The interceptor module's import starts before patch() installs the
    # finder, so no hook reports its end; its SDK import comes after, and
    # ends while the module is still executing, too early to patch.
    # patch() has to wait for the module's import and patch the SDK itself.
    importer = threading.Thread(target=importlib.import_module, args=(fake_sdk_on_disk.module,))
    importer.start()
    assert gate.ENTERED.wait(THREAD_WAIT_SECS)
    patcher = threading.Thread(target=_patch)
    patcher.start()
    # Give patch() time to reach the import in progress: one that did not
    # wait for it would return before the SDK is imported, and nothing
    # would patch it later.
    patcher.join(PATCH_HEAD_START_SECS)
    gate.RELEASE.set()
    importer.join(THREAD_WAIT_SECS)
    patcher.join(THREAD_WAIT_SECS)
    assert sys.modules[fake_sdk_on_disk.name].CALLS == [("patch", "True")]


def test_an_interceptor_module_imported_after_unpatch_patches_nothing(
    fake_sdk_on_disk: Any,
) -> None:
    fake_sdk_on_disk.write(_INTERCEPTOR_SOURCE)
    _patch()
    flightdeck_sensor.unpatch()
    importlib.import_module(fake_sdk_on_disk.module)
    assert sys.modules[fake_sdk_on_disk.name].CALLS == []


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


def test_every_lazy_name_is_typed_for_checkers() -> None:
    # A type checker never runs __getattr__: each lazy name is imported
    # under TYPE_CHECKING, from the interceptor module it resolves from.
    tree = ast.parse(Path(flightdeck_sensor.__file__).read_text(encoding="utf-8"))
    typed: dict[str, str] = {}
    for node in tree.body:
        if not (isinstance(node, ast.If) and ast.unparse(node.test) == "TYPE_CHECKING"):
            continue
        for stmt in node.body:
            if isinstance(stmt, ast.ImportFrom) and stmt.module is not None:
                package, _, interceptor = stmt.module.rpartition(".")
                if package == "flightdeck_sensor.interceptor":
                    typed.update({alias.asname or alias.name: interceptor for alias in stmt.names})
    assert typed == flightdeck_sensor._LAZY_EXPORTS
