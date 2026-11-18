"""The network guard the unit tests run under: one implementation for the
test process (``_no_network`` in ``tests/conftest.py`` applies it to each
test) and for the child processes the tests start (``install_in_child``).

The rules: a name lookup only where it cannot leave the machine, that is
no host (a lookup for binding), exactly ``localhost`` (the resolver
answers it from the hosts file; a name under it reaches a name server on
plain glibc), or an address literal (returned without asking anyone); a
reverse lookup only of a loopback address or ``localhost``; a connection
or a datagram only to a loopback address.

They are enforced where a name can be resolved through Python's
``socket`` module:

- its resolver functions (``getaddrinfo``, ``gethostbyname``,
  ``gethostbyname_ex``, ``gethostbyaddr``, ``getnameinfo``; ``getfqdn``
  and ``create_connection`` call these), replaced by checking versions;
- the ``socket.socket`` methods that take an address (``connect``,
  ``connect_ex``, ``bind``, ``sendto``, ``sendmsg``), replaced the same
  way, because they resolve a host name themselves before any audit
  event is raised;
- an audit hook for the resolver functions reached through a reference
  taken before the replacement (``from socket import getaddrinfo``),
  which raises before the lookup is made.

A refusal raises what the real call raises when it fails the same way
(``gaierror`` for a forward lookup or ``getnameinfo``, ``herror`` for
``gethostbyaddr``, ``ConnectionRefusedError`` for a connection, and
``connect_ex`` returns ``ECONNREFUSED``), so the code under test takes
its production path; and every refusal is handed to a recorder, which
makes the test fail. Not seen: a resolver outside Python's ``socket``
module (a C library with its own sockets).

Standard library only: a child imports this before anything else, so it
loads nothing a child checks for.
"""

from __future__ import annotations

import errno
import ipaddress
import os
import socket
import sys
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable

    # (kind, host): what was refused, for the test to report.
    Recorder = Callable[[str, object], None]

# Set in a child's environment to the file its refusals are appended to;
# the test that started the child fails when the file is not empty.
CHILD_LOG_ENV = "SENSOR_TESTS_NETWORK_LOG"

# The kinds of refusal: a name lookup (forward, reverse, or one a socket
# call would make), and traffic to an address off the machine.
LOOKUP = "lookup"
TRAFFIC = "traffic"

_INET_FAMILIES = (socket.AF_INET, socket.AF_INET6)
# gethostbyaddr's h_errno for a name that does not exist.
_HOST_NOT_FOUND = 1


def _text(host: object) -> str | None:
    if isinstance(host, bytes):
        return host.decode("ascii", errors="replace")
    return host if isinstance(host, str) else None


def _address(host: object) -> ipaddress.IPv4Address | ipaddress.IPv6Address | None:
    """``host`` as an address literal (an IPv6 zone aside), else None."""
    text = _text(host)
    if text is None:
        return None
    try:
        return ipaddress.ip_address(text.split("%", 1)[0])
    except ValueError:
        return None


def is_loopback(host: object) -> bool:
    """Exactly ``localhost`` (any case) or a loopback address literal."""
    text = _text(host)
    if text is not None and text.lower() == "localhost":
        return True
    address = _address(host)
    return address is not None and address.is_loopback


def resolves_without_dns(host: object) -> bool:
    """Whether a forward lookup of ``host`` stays on the machine."""
    if host is None or host in ("", b""):
        return True
    return is_loopback(host) or _address(host) is not None


def _lookup_error(host: object) -> socket.gaierror:
    return socket.gaierror(socket.EAI_NONAME, f"unit tests may not resolve {host!r}")


def _address_refusal(
    sock: Any, address: object, *, binding: bool
) -> tuple[str, object, BaseException] | None:
    """What a socket call given ``address`` would do that the rules refuse:
    resolve a name, or reach an address off the machine."""
    if getattr(sock, "family", None) not in _INET_FAMILIES or not isinstance(address, tuple):
        return None
    if not address:
        return None
    host = address[0]
    if binding:
        return None if resolves_without_dns(host) else (LOOKUP, host, _lookup_error(host))
    if is_loopback(host):
        return None
    if _address(host) is None:
        return LOOKUP, host, _lookup_error(host)
    refused = ConnectionRefusedError(
        errno.ECONNREFUSED, f"unit tests may not connect to {address!r}"
    )
    return TRAFFIC, host, refused


def replacements(record: Recorder) -> list[tuple[object, str, Callable[..., Any]]]:
    """``(owner, name, replacement)`` for each resolver function of the
    ``socket`` module and each ``socket.socket`` method that takes an
    address: the replacement refuses, and records, what the rules refuse
    before the real call can resolve or send anything, and otherwise is
    the real call."""
    real_getaddrinfo = socket.getaddrinfo
    real_gethostbyname = socket.gethostbyname
    real_gethostbyname_ex = socket.gethostbyname_ex
    real_gethostbyaddr = socket.gethostbyaddr
    real_getnameinfo = socket.getnameinfo
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex
    real_bind = socket.socket.bind
    real_sendto = socket.socket.sendto
    real_sendmsg = socket.socket.sendmsg

    def _forward(host: object) -> None:
        if not resolves_without_dns(host):
            record(LOOKUP, host)
            raise _lookup_error(host)

    def getaddrinfo(host: Any, *args: Any, **kwargs: Any) -> Any:
        _forward(host)
        return real_getaddrinfo(host, *args, **kwargs)

    def gethostbyname(host: Any) -> Any:
        _forward(host)
        return real_gethostbyname(host)

    def gethostbyname_ex(host: Any) -> Any:
        _forward(host)
        return real_gethostbyname_ex(host)

    def gethostbyaddr(host: Any) -> Any:
        # A reverse lookup asks a name server even for an address literal.
        if not is_loopback(host):
            record(LOOKUP, host)
            raise socket.herror(_HOST_NOT_FOUND, f"unit tests may not look up {host!r}")
        return real_gethostbyaddr(host)

    def getnameinfo(sockaddr: Any, flags: int) -> Any:
        host = sockaddr[0] if isinstance(sockaddr, tuple) and sockaddr else None
        if not flags & socket.NI_NUMERICHOST and not is_loopback(host):
            record(LOOKUP, host)
            raise _lookup_error(host)
        return real_getnameinfo(sockaddr, flags)

    def _check(sock: Any, address: object, *, binding: bool = False) -> None:
        refusal = _address_refusal(sock, address, binding=binding)
        if refusal is not None:
            kind, host, error = refusal
            record(kind, host)
            raise error

    def connect(self: socket.socket, address: Any) -> Any:
        _check(self, address)
        return real_connect(self, address)

    def connect_ex(self: socket.socket, address: Any) -> Any:
        refusal = _address_refusal(self, address, binding=False)
        if refusal is not None:
            kind, host, error = refusal
            record(kind, host)
            if kind == TRAFFIC:
                return errno.ECONNREFUSED  # connect_ex reports, it does not raise
            raise error
        return real_connect_ex(self, address)

    def bind(self: socket.socket, address: Any) -> Any:
        _check(self, address, binding=True)
        return real_bind(self, address)

    def sendto(self: socket.socket, data: Any, *args: Any) -> Any:
        _check(self, args[-1] if args else None)
        return real_sendto(self, data, *args)

    def sendmsg(self: socket.socket, buffers: Any, *args: Any) -> Any:
        _check(self, args[2] if len(args) > 2 else None)
        return real_sendmsg(self, buffers, *args)

    return [
        (socket, "getaddrinfo", getaddrinfo),
        (socket, "gethostbyname", gethostbyname),
        (socket, "gethostbyname_ex", gethostbyname_ex),
        (socket, "gethostbyaddr", gethostbyaddr),
        (socket, "getnameinfo", getnameinfo),
        (socket.socket, "connect", connect),
        (socket.socket, "connect_ex", connect_ex),
        (socket.socket, "bind", bind),
        (socket.socket, "sendto", sendto),
        (socket.socket, "sendmsg", sendmsg),
    ]


def audit_hook(
    record: Recorder, *, enabled: Callable[[], bool] | None = None
) -> Callable[[str, tuple[Any, ...]], None]:
    """An audit hook refusing, before the lookup, what the rules refuse of
    a resolver function reached without the replacements (a reference
    taken before them). ``getnameinfo`` is left to its replacement: its
    audit event does not carry the flags that make it numeric."""

    def _hook(event: str, args: tuple[Any, ...]) -> None:
        if event not in ("socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr"):
            return
        if enabled is not None and not enabled():
            return
        host = args[0]
        if event == "socket.gethostbyaddr":
            if not is_loopback(host):
                record(LOOKUP, host)
                raise socket.herror(_HOST_NOT_FOUND, f"unit tests may not look up {host!r}")
        elif not resolves_without_dns(host):
            record(LOOKUP, host)
            raise _lookup_error(host)

    return _hook


def _log_to(path: str) -> Recorder:
    def _record(kind: str, host: object) -> None:
        with open(path, "a", encoding="utf-8") as log:
            log.write(f"{kind} {host!r}\n")

    return _record


def install_in_child(record: Recorder | None = None) -> None:
    """Guard the rest of this child process. Refusals go to ``record``, or
    are appended to the file ``CHILD_LOG_ENV`` names (nothing is
    installed when it is unset), for the test that started the child."""
    if record is None:
        path = os.environ.get(CHILD_LOG_ENV)
        if not path:
            return
        record = _log_to(path)
    for owner, name, replacement in replacements(record):
        setattr(owner, name, replacement)
    sys.addaudithook(audit_hook(record))
