"""flightdeck-cli: the Flightdeck binary, delivered through PyPI.

The wheel for each platform carries the prebuilt ``flightdeck`` binary
under ``flightdeck_cli/bin/`` and exposes it as the ``flightdeck`` (and
``flightdeck-cli``, for ``uvx flightdeck-cli``) console script. This
module is the shim: it finds the binary next to itself and hands the
process over to it with the arguments as given.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

BINARY_NAME = "flightdeck.exe" if sys.platform == "win32" else "flightdeck"


def binary_path() -> Path:
    """The bundled binary's path."""
    return Path(__file__).resolve().parent / "bin" / BINARY_NAME


def main() -> None:
    """Run the bundled binary with this process's arguments.

    On POSIX the binary replaces this process (``execv``), so signals,
    the exit status and the terminal belong to it directly. Windows has
    no ``exec``; the binary runs as a child and its exit status is
    returned, with Ctrl+C left to the child (the parent ignores it).
    """
    binary = binary_path()
    if not binary.is_file():
        sys.exit(
            f"flightdeck-cli: the bundled binary is missing at {binary}; "
            "reinstall the package (pip install --force-reinstall flightdeck-cli)"
        )
    args = [str(binary), *sys.argv[1:]]
    if sys.platform == "win32":
        import signal

        signal.signal(signal.SIGINT, signal.SIG_IGN)
        sys.exit(subprocess.call(args))
    os.execv(str(binary), args)


if __name__ == "__main__":
    main()
