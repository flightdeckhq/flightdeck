"""Run a callback when a module finishes importing.

``patch()`` patches an SDK the application has not imported yet at the
moment the application imports it, instead of importing every installed
SDK itself. :func:`watch` puts a finder at the front of ``sys.meta_path``.
For a watched module name, and only for one, the finder asks the finders
after it for the module's spec and wraps the spec's loader, so the
callback runs right after the module's code has executed: in the
importing thread, before the ``import`` statement returns. Every other
import passes through after one dictionary lookup.

The wrapping loader puts the module's own loader back on ``__loader__``
and ``__spec__.loader`` before the module executes, so nothing after the
import sees the wrapper. A reload executes the module again through the
finder, so the callback runs again; an import that raises runs none.

The callback runs inside the import, under the module's import lock, so
it must never wait for another thread: a thread waiting for this import
to finish would wait forever. An exception it raises is logged, never
raised into the application's import.
"""

from __future__ import annotations

import contextlib
import importlib
import importlib.abc
import logging
import sys
import threading
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, Sequence
    from importlib.machinery import ModuleSpec
    from types import ModuleType

_log = logging.getLogger("flightdeck_sensor.core.import_hook")

# Marks the finder and the loader wrapper. Matched by attribute rather than
# by class, so the finder of a reloaded copy of this module is still found
# and removed.
_MARKER = "_flightdeck_import_hook"

# Watched module name -> callback. Replaced whole, never mutated in place,
# so the finder reads it without a lock on every import in the process.
_callbacks: Mapping[str, Callable[[str], None]] = {}

# Serialises watch() and unwatch(). Held only while the mapping and
# sys.meta_path are updated, never during an import.
_state_lock = threading.Lock()


def watch(callbacks: Mapping[str, Callable[[str], None]]) -> None:
    """Call ``callbacks[name](name)`` each time the module ``name``
    finishes executing (its first import and each reload) until
    :func:`unwatch`. Adds to the names already watched, a name given
    again takes its new callback, and the finder is installed once.

    A module imported before this call is not reported; see
    :func:`imported`.
    """
    global _callbacks
    with _state_lock:
        _callbacks = {**_callbacks, **callbacks}
        if not any(_is_ours(finder) for finder in sys.meta_path):
            sys.meta_path.insert(0, _Finder())


def unwatch() -> None:
    """Stop watching every name and take the finder out of
    ``sys.meta_path``. Idempotent. An import already past the finder
    finds no callback when it finishes, so it runs none."""
    global _callbacks
    with _state_lock:
        _callbacks = {}
        for finder in [f for f in sys.meta_path if _is_ours(f)]:
            with contextlib.suppress(ValueError):
                sys.meta_path.remove(finder)


def watching(name: str) -> bool:
    """Whether :func:`watch` is watching the module ``name``."""
    return name in _callbacks


def imported(name: str) -> ModuleType | None:
    """The module ``name`` once the application has imported it, else
    None; never imports it.

    A module another thread is still importing is waited for, so the
    caller sees it whole. One this thread is importing (the caller runs
    inside that import) is reported as not imported yet, because its code
    has not finished.
    """
    module = sys.modules.get(name)
    if module is None or not _initializing(module):
        return module
    _wait_for_import(name)
    module = sys.modules.get(name)
    if module is None or _initializing(module):
        return None
    return module


# ----------------------------------------------------------------------
# Internals
# ----------------------------------------------------------------------


def _is_ours(obj: object) -> bool:
    return getattr(obj, _MARKER, False) is True


def _initializing(module: object) -> bool:
    """Whether ``module`` is still being imported. The import system sets
    ``__spec__._initializing`` for the length of a first import (it reads
    it the same way to decide whether to wait for one)."""
    return getattr(getattr(module, "__spec__", None), "_initializing", False) is True


def _wait_for_import(name: str) -> None:
    """Wait until no thread is importing ``name``. Returns at once when
    this thread is the importer, since the module's import lock is
    re-entrant for its owner.

    ``_lock_unlock_module`` takes and releases the module's import lock,
    which is what the import system does to wait for another thread's
    import, and it imports nothing. Without it (a Python that dropped
    it), importing the module waits the same way: the module is already
    being imported, so this does not import an SDK the application did
    not import.
    """
    bootstrap: Any = sys.modules.get("importlib._bootstrap")
    lock_unlock = getattr(bootstrap, "_lock_unlock_module", None)
    try:
        if lock_unlock is not None:
            lock_unlock(name)
        else:
            importlib.import_module(name)
    except Exception:
        # The import system's deadlock error (the importer is waiting on
        # this thread), or the other thread's import failed: either way
        # the module is not there to patch.
        _log.debug("waiting for the import of %s failed", name, exc_info=True)


def _find_below(
    finder: _Finder,
    fullname: str,
    path: Sequence[str] | None,
    target: ModuleType | None,
) -> ModuleSpec | None:
    """The spec the finders after ``finder`` in ``sys.meta_path`` give
    for ``fullname``: the spec the import system would have used had the
    finder not been there. The finders before it have already returned
    nothing for this import."""
    finders = list(sys.meta_path)
    try:
        start = finders.index(finder) + 1
    except ValueError:
        return None  # taken out of sys.meta_path while this import ran
    for below in finders[start:]:
        find_spec = getattr(below, "find_spec", None)
        if find_spec is None:
            continue
        spec: ModuleSpec | None = find_spec(fullname, path, target)
        if spec is not None:
            return spec
    return None


def _notify(name: str) -> None:
    """Run the callback for ``name``, if it is still watched. Never
    raises: a failed patch leaves the SDK unmetered, not the application's
    import broken."""
    callback = _callbacks.get(name)
    if callback is None:
        return  # unwatched while the module was importing
    try:
        callback(name)
    except Exception:
        _log.warning(
            "flightdeck_sensor: patching %s as it was imported failed; its calls are not metered",
            name,
            exc_info=True,
        )


def _restore_loader(module: ModuleType, wrapper: _Loader, loader: Any) -> None:
    """Put the module's own loader back where the import system recorded
    the wrapper, so tools that read it later (``importlib.resources``,
    ``inspect``, ``pkgutil``) talk to the real loader."""
    if getattr(module, "__loader__", None) is wrapper:
        with contextlib.suppress(AttributeError, TypeError):
            module.__loader__ = loader
    spec = getattr(module, "__spec__", None)
    if spec is not None and getattr(spec, "loader", None) is wrapper:
        spec.loader = loader


class _Finder(importlib.abc.MetaPathFinder):
    """The ``sys.meta_path`` finder :func:`watch` installs."""

    _flightdeck_import_hook = True

    def __init__(self) -> None:
        # Names this thread is resolving: a finder after this one may ask
        # the import system for the same name again (wrapt's post-import
        # hook finder does), and that inner lookup must find the plain spec
        # rather than recurse into this finder.
        self._resolving = threading.local()

    def find_spec(
        self,
        fullname: str,
        path: Sequence[str] | None,
        target: ModuleType | None = None,
    ) -> ModuleSpec | None:
        if fullname not in _callbacks:
            return None
        resolving: set[str] = self._resolving.__dict__.setdefault("names", set())
        if fullname in resolving:
            return None
        resolving.add(fullname)
        try:
            spec = _find_below(self, fullname, path, target)
        finally:
            resolving.discard(fullname)
        if spec is None or spec.loader is None or _is_ours(spec.loader):
            # Not found, a namespace package (no code runs, so there is no
            # end of import to report), or already wrapped.
            return spec
        spec.loader = _Loader(spec.loader, fullname)
        return spec


class _Loader(importlib.abc.Loader):
    """Wraps a watched module's loader: executes the module with it, then
    runs the module's callback."""

    _flightdeck_import_hook = True

    def __init__(self, loader: Any, name: str) -> None:
        self._loader = loader
        self._name = name

    def create_module(self, spec: ModuleSpec) -> ModuleType | None:
        create = getattr(self._loader, "create_module", None)
        return create(spec) if create is not None else None

    def exec_module(self, module: ModuleType) -> None:
        _restore_loader(module, self, self._loader)
        self._loader.exec_module(module)
        _notify(self._name)

    def __getattr__(self, name: str) -> Any:
        # Everything else (get_code, get_source, is_package,
        # get_resource_reader, ...) is the module's own loader's.
        if name in ("_loader", "_name"):
            raise AttributeError(name)
        return getattr(self._loader, name)
