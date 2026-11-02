"""The post-import hook patch() uses to patch an SDK as it is imported.

Exercised with real modules written to a temporary directory, so the
import system finds, loads and reloads them as it would an SDK.
"""

from __future__ import annotations

import importlib
import importlib.abc
import importlib.util
import inspect
import sys
import threading
import uuid
from collections.abc import Callable, Iterator, Sequence
from typing import TYPE_CHECKING, Any

import pytest

from flightdeck_sensor.core import import_hook

if TYPE_CHECKING:
    from pathlib import Path
    from types import ModuleType

THREAD_WAIT_SECS = 10.0
# Time given to a thread to reach a wait the test then releases; a thread
# that skipped the wait finishes well within it.
PROBE_HEAD_START_SECS = 0.2

ModuleMaker = Callable[..., str]


@pytest.fixture()
def make_module(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[ModuleMaker]:
    """Write a module (or, with ``package=True``, a package) to a
    directory on ``sys.path`` and return its unique name. Watches and the
    modules are cleared afterwards."""
    monkeypatch.syspath_prepend(str(tmp_path))
    created: list[str] = []

    def make(source: str = "", *, package: bool = False, init: bool = True) -> str:
        name = f"fd_hook_{uuid.uuid4().hex[:12]}"
        if package:
            (tmp_path / name).mkdir()
            if init:
                (tmp_path / name / "__init__.py").write_text(source)
        else:
            (tmp_path / f"{name}.py").write_text(source)
        importlib.invalidate_caches()
        created.append(name)
        return name

    yield make
    import_hook.unwatch()
    for name in created:
        sys.modules.pop(name, None)


def _ours() -> list[Any]:
    return [f for f in sys.meta_path if getattr(f, "_flightdeck_import_hook", False) is True]


def test_the_callback_runs_once_the_module_has_executed(make_module: ModuleMaker) -> None:
    name = make_module("FIRST = 1\nLAST = 2\n")
    seen: list[tuple[str, int]] = []
    import_hook.watch({name: lambda n: seen.append((n, sys.modules[n].LAST))})
    importlib.import_module(name)
    importlib.import_module(name)
    assert seen == [(name, 2)]


def test_the_module_keeps_its_own_loader(make_module: ModuleMaker) -> None:
    name = make_module("def f():\n    return 1\n")
    import_hook.watch({name: lambda _n: None})
    module = importlib.import_module(name)
    assert module.__spec__ is not None
    assert not getattr(module.__spec__.loader, "_flightdeck_import_hook", False)
    assert not getattr(module.__loader__, "_flightdeck_import_hook", False)
    assert "return 1" in inspect.getsource(module)


def test_watch_installs_one_finder_at_the_front(make_module: ModuleMaker) -> None:
    name = make_module()
    import_hook.watch({name: lambda _n: None})
    import_hook.watch({name: lambda _n: None})
    assert len(_ours()) == 1
    assert sys.meta_path[0] is _ours()[0]


def test_unwatch_removes_the_finder_and_stops_the_callbacks(make_module: ModuleMaker) -> None:
    name = make_module()
    seen: list[str] = []
    import_hook.watch({name: seen.append})
    import_hook.unwatch()
    import_hook.unwatch()
    assert _ours() == []
    assert not import_hook.watching(name)
    importlib.import_module(name)
    assert seen == []


def test_a_reload_runs_the_callback_again(make_module: ModuleMaker) -> None:
    name = make_module("VALUE = 1\n")
    seen: list[str] = []
    import_hook.watch({name: seen.append})
    module = importlib.import_module(name)
    importlib.reload(module)
    assert seen == [name, name]


def test_an_import_that_fails_runs_no_callback(make_module: ModuleMaker, tmp_path: Path) -> None:
    name = make_module("raise RuntimeError('broken SDK')\n")
    seen: list[str] = []
    import_hook.watch({name: seen.append})
    with pytest.raises(RuntimeError, match="broken SDK"):
        importlib.import_module(name)
    assert seen == []
    assert name not in sys.modules
    (tmp_path / f"{name}.py").write_text("FIXED = True\n")
    importlib.invalidate_caches()
    importlib.import_module(name)
    assert seen == [name]


def test_a_failing_callback_never_breaks_the_import(
    make_module: ModuleMaker, caplog: pytest.LogCaptureFixture
) -> None:
    name = make_module("VALUE = 1\n")

    def broken(_name: str) -> None:
        raise RuntimeError("patch failed")

    import_hook.watch({name: broken})
    assert importlib.import_module(name).VALUE == 1
    assert f"patching {name} as it was imported failed" in caplog.text


def test_a_callback_can_import_another_watched_module(make_module: ModuleMaker) -> None:
    inner = make_module("VALUE = 1\n")
    outer = make_module("VALUE = 2\n")
    seen: list[str] = []

    def on_outer(name: str) -> None:
        importlib.import_module(inner)
        seen.append(name)

    import_hook.watch({outer: on_outer, inner: seen.append})
    importlib.import_module(outer)
    assert seen == [inner, outer]


def test_a_package_and_its_submodules(make_module: ModuleMaker, tmp_path: Path) -> None:
    package = make_module("NAME = 'pkg'\n", package=True)
    (tmp_path / package / "sub.py").write_text("NAME = 'sub'\n")
    seen: list[str] = []
    import_hook.watch({package: seen.append})
    # Importing a submodule imports its package first; the package's
    # callback runs once, the unwatched submodule's not at all.
    importlib.import_module(f"{package}.sub")
    assert seen == [package]


def test_a_namespace_package_is_left_alone(make_module: ModuleMaker) -> None:
    package = make_module(package=True, init=False)
    seen: list[str] = []
    import_hook.watch({package: seen.append})
    # No code runs for a namespace package, so there is no end of import
    # to report; the import itself is untouched.
    importlib.import_module(package)
    assert seen == []


class _ReentrantFinder(importlib.abc.MetaPathFinder):
    """Asks the import system for a name again from its own find_spec,
    as wrapt's post-import hook finder does."""

    def __init__(self, name: str) -> None:
        self.name = name
        self.busy = False

    def find_spec(
        self, fullname: str, path: Sequence[str] | None, target: ModuleType | None = None
    ) -> Any:
        if fullname != self.name or self.busy:
            return None
        self.busy = True
        try:
            return importlib.util.find_spec(fullname)
        finally:
            self.busy = False


def test_a_finder_below_that_asks_again_gets_the_plain_spec(make_module: ModuleMaker) -> None:
    name = make_module("VALUE = 1\n")
    seen: list[str] = []
    import_hook.watch({name: seen.append})
    reentrant = _ReentrantFinder(name)
    sys.meta_path.insert(1, reentrant)
    try:
        module = importlib.import_module(name)
    finally:
        sys.meta_path.remove(reentrant)
    assert module.VALUE == 1
    assert seen == [name]


def test_concurrent_imports_run_the_callback_once(make_module: ModuleMaker) -> None:
    name = make_module("import time\ntime.sleep(0.05)\nVALUE = 1\n")
    seen: list[str] = []
    import_hook.watch({name: seen.append})
    barrier = threading.Barrier(8)

    def import_it() -> None:
        barrier.wait(THREAD_WAIT_SECS)
        assert importlib.import_module(name).VALUE == 1

    threads = [threading.Thread(target=import_it) for _ in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(THREAD_WAIT_SECS)
    assert seen == [name]


def test_imported_never_imports(make_module: ModuleMaker) -> None:
    name = make_module("VALUE = 1\n")
    assert import_hook.imported(name) is None
    assert name not in sys.modules
    module = importlib.import_module(name)
    assert import_hook.imported(name) is module


def test_imported_waits_for_an_import_in_progress(make_module: ModuleMaker) -> None:
    gate = make_module(
        "import threading\nENTERED = threading.Event()\nRELEASE = threading.Event()\n"
    )
    gate_module = importlib.import_module(gate)
    name = make_module(
        f"import {gate}\n{gate}.ENTERED.set()\n{gate}.RELEASE.wait({THREAD_WAIT_SECS})\nVALUE = 1\n"
    )
    importer = threading.Thread(target=importlib.import_module, args=(name,))
    importer.start()
    assert gate_module.ENTERED.wait(THREAD_WAIT_SECS)
    seen: list[Any] = []
    prober = threading.Thread(target=lambda: seen.append(import_hook.imported(name)))
    prober.start()
    # The import cannot finish before RELEASE, so the probe is still
    # waiting for it; one that did not wait would be done by now.
    prober.join(PROBE_HEAD_START_SECS)
    assert prober.is_alive()
    gate_module.RELEASE.set()
    importer.join(THREAD_WAIT_SECS)
    prober.join(THREAD_WAIT_SECS)
    # The probe returned the module whole, never half-initialised.
    assert [getattr(m, "VALUE", None) for m in seen] == [1]


def test_imported_reports_a_module_this_thread_is_importing_as_not_yet(
    make_module: ModuleMaker,
) -> None:
    name = make_module(
        "from flightdeck_sensor.core import import_hook\n"
        "SEEN_DURING_IMPORT = import_hook.imported(__name__)\n"
    )
    module = importlib.import_module(name)
    assert module.SEEN_DURING_IMPORT is None
    assert import_hook.imported(name) is module
