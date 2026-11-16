"""Posting a framework wrap's child-session events off the event loop.

A wrap whose framework runs on asyncio posts a child's ``session_start``,
its framework signals and its ``session_end`` from the loop's executor,
apart from any task, so the loop is never held and cancelling the task
that waits for a post cannot drop it; the session's ``end()`` waits for
posts still running. A child's posts are chained: one queued while the
child's previous post is still running is queued from that post's
completion, in the thread that finishes it, so they arrive in order and
no thread waits. The LangGraph and Google ADK wraps post this way.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import threading
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from collections.abc import Callable

    from flightdeck_sensor.core.session import Session


class PostChain(Protocol):
    """A child whose posts are chained: its session, and its last post."""

    session: Session
    last_post: concurrent.futures.Future[None] | None


def _submit(loop: asyncio.AbstractEventLoop, run: Callable[[], None]) -> None:
    """Run ``run`` on the loop's executor; in place when the executor no
    longer takes work (the loop is shutting down)."""
    try:
        loop.run_in_executor(None, run)
    except RuntimeError:
        run()


def queue_post(
    child: PostChain, post: Callable[..., None], *args: Any
) -> concurrent.futures.Future[None]:
    """Queue a post of ``child`` on the running loop's executor and make it
    the child's last post (see the module docstring). Posted in place when
    no loop runs in this thread. ``post`` must not raise."""
    done: concurrent.futures.Future[None] = concurrent.futures.Future()

    def run() -> None:
        try:
            post(*args)
        finally:
            done.set_result(None)

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        run()
        return done
    child.session.track_child_post(done)
    previous, child.last_post = child.last_post, done
    if previous is None or previous.done():
        _submit(loop, run)
        return done
    loop_thread = threading.get_ident()

    def after_previous(_: concurrent.futures.Future[None]) -> None:
        # Called on the loop's thread when the previous post finished
        # before the callback was added; the post must not run there.
        if threading.get_ident() == loop_thread:
            _submit(loop, run)
        else:
            run()

    previous.add_done_callback(after_previous)
    return done


async def wait_post(post: concurrent.futures.Future[None]) -> None:
    """Wait for a queued post. A cancellation of the waiter propagates and
    leaves the post running."""
    await asyncio.shield(asyncio.wrap_future(post))
