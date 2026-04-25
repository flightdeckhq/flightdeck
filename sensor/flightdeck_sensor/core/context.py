"""Runtime context auto-collection for the flightdeck sensor.

The sensor calls :func:`collect` once at ``init()`` time and attaches
the resulting dict to the ``session_start`` event payload. The control
plane stores this once per session in ``sessions.context`` (JSONB) and
the dashboard surfaces it in the CONTEXT sidebar facet panel and the
session drawer's RUNTIME panel.

Design rules:

- Every collector is best-effort. If a collector raises for any reason
  the agent continues normally with no field attached.
- ``BaseCollector.collect()`` wraps ``_gather()`` in a try/except. The
  outer ``collect()`` orchestrator wraps each collector call in a
  second try/except. Two layers of protection means a single broken
  collector cannot crash the sensor.
- Orchestration collectors run in priority order (Kubernetes first).
  The first one whose ``applies()`` returns ``True`` wins; the rest
  are skipped. This avoids ambiguous "kubernetes AND docker" results
  inside k8s pods that also have ``/.dockerenv``.
- Framework classifiers inspect ``sys.modules`` only. They never
  import anything new -- if a framework wasn't loaded by the agent
  before ``init()`` ran, we don't claim it's in use.
- No network calls, no shell-outs longer than 500 ms, no writes to
  the user's filesystem.
"""

from __future__ import annotations

import os
import platform
import re
import socket
import subprocess
import sys
from typing import Any, Protocol

# ----------------------------------------------------------------------
# Protocol + base
# ----------------------------------------------------------------------


class ContextCollector(Protocol):
    """Pluggable runtime context collector."""

    def applies(self) -> bool: ...

    def collect(self) -> dict[str, Any]: ...


class BaseCollector:
    """Default base. Subclasses override ``_gather`` only."""

    def applies(self) -> bool:
        return True

    def _gather(self) -> dict[str, Any]:
        raise NotImplementedError

    def collect(self) -> dict[str, Any]:
        try:
            return self._gather()
        except Exception:
            return {}


# ----------------------------------------------------------------------
# Process + system collectors
# ----------------------------------------------------------------------


class ProcessCollector(BaseCollector):
    def _gather(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        result["pid"] = os.getpid()
        argv0 = sys.argv[0] if sys.argv else ""
        if argv0:
            result["process_name"] = os.path.basename(argv0)
        return result


class OSCollector(BaseCollector):
    def _gather(self) -> dict[str, Any]:
        return {
            "os": platform.system(),
            "arch": platform.machine(),
            "hostname": socket.gethostname(),
        }


class UserCollector(BaseCollector):
    def _gather(self) -> dict[str, Any]:
        # USER on Unix, USERNAME on Windows, LOGNAME as final fallback.
        user = (
            os.environ.get("USER")
            or os.environ.get("USERNAME")
            or os.environ.get("LOGNAME")
        )
        return {"user": user} if user else {}


class PythonCollector(BaseCollector):
    def _gather(self) -> dict[str, Any]:
        return {"python_version": platform.python_version()}


# ----------------------------------------------------------------------
# Git collector
# ----------------------------------------------------------------------


class GitCollector(BaseCollector):
    """Read commit / branch / repo from the agent's working directory.

    Uses subprocess with a 500 ms timeout. Strips embedded credentials
    from the remote URL before extracting the repo name. Returns an
    empty dict if git is not installed or the cwd is not a repo --
    both via the broad ``except Exception`` in :meth:`_run` (which
    also catches ``FileNotFoundError`` on Windows when git.exe is
    missing from PATH).
    """

    def _run(self, *args: str) -> str | None:
        try:
            out = subprocess.check_output(
                ["git", *args],
                timeout=0.5,
                stderr=subprocess.DEVNULL,
                cwd=os.getcwd(),
            )
            return out.decode().strip() or None
        except Exception:
            return None

    def _gather(self) -> dict[str, Any]:
        result: dict[str, Any] = {}
        commit = self._run("rev-parse", "--short", "HEAD")
        branch = self._run("branch", "--show-current")
        remote = self._run("remote", "get-url", "origin")
        if commit:
            result["git_commit"] = commit
        if branch:
            result["git_branch"] = branch
        if remote:
            # Strip embedded credentials before extracting the repo name.
            clean = re.sub(r"https?://[^@]+@", "https://", remote)
            repo = os.path.basename(clean.rstrip("/"))
            if repo.endswith(".git"):
                repo = repo[:-4]
            if repo:
                result["git_repo"] = repo
        return result


# ----------------------------------------------------------------------
# Orchestration collectors -- priority order, first match wins
# ----------------------------------------------------------------------


class KubernetesCollector(BaseCollector):
    def applies(self) -> bool:
        return bool(os.environ.get("KUBERNETES_SERVICE_HOST"))

    def _gather(self) -> dict[str, Any]:
        result: dict[str, Any] = {"orchestration": "kubernetes"}
        pod = (
            os.environ.get("MY_POD_NAME")
            or os.environ.get("POD_NAME")
            or os.environ.get("HOSTNAME")
        )
        ns = os.environ.get("MY_POD_NAMESPACE") or os.environ.get("POD_NAMESPACE")
        node = os.environ.get("MY_NODE_NAME") or os.environ.get("NODE_NAME")
        if pod:
            result["k8s_pod"] = pod
        if ns:
            result["k8s_namespace"] = ns
        if node:
            result["k8s_node"] = node
        return result


class DockerComposeCollector(BaseCollector):
    def applies(self) -> bool:
        return bool(
            os.environ.get("COMPOSE_PROJECT_NAME")
            or os.environ.get("COMPOSE_SERVICE")
        )

    def _gather(self) -> dict[str, Any]:
        result: dict[str, Any] = {"orchestration": "docker-compose"}
        project = os.environ.get("COMPOSE_PROJECT_NAME")
        service = os.environ.get("COMPOSE_SERVICE")
        if project:
            result["compose_project"] = project
        if service:
            result["compose_service"] = service
        return result


class DockerCollector(BaseCollector):
    def applies(self) -> bool:
        # /.dockerenv only exists inside Linux containers; on Windows
        # or Mac hosts running Python natively this collector
        # correctly returns nothing.
        return os.path.exists("/.dockerenv")

    def _gather(self) -> dict[str, Any]:
        return {"orchestration": "docker"}


class AWSECSCollector(BaseCollector):
    def applies(self) -> bool:
        return bool(
            os.environ.get("ECS_CONTAINER_METADATA_URI")
            or os.environ.get("ECS_CONTAINER_METADATA_URI_V4")
        )

    def _gather(self) -> dict[str, Any]:
        result: dict[str, Any] = {"orchestration": "aws-ecs"}
        task = os.environ.get("ECS_TASK_DEFINITION")
        if task:
            result["ecs_task"] = os.path.basename(task)
        return result


class CloudRunCollector(BaseCollector):
    def applies(self) -> bool:
        return bool(os.environ.get("K_SERVICE"))

    def _gather(self) -> dict[str, Any]:
        result: dict[str, Any] = {"orchestration": "cloud-run"}
        svc = os.environ.get("K_SERVICE")
        rev = os.environ.get("K_REVISION")
        if svc:
            result["cloud_run_service"] = svc
        if rev:
            result["cloud_run_revision"] = rev
        return result


# ----------------------------------------------------------------------
# Framework classifier
# ----------------------------------------------------------------------


class BaseClassifier:
    """Inspects ``sys.modules`` for a known framework. Never imports.

    ``module`` may be a single module name (``"langchain"``) or a
    list/tuple of module names. When multiple are listed they're
    treated as aliases — any one being in ``sys.modules`` is enough
    to consider the framework present, and the detected version
    comes from the first match. Pre-fix the classifier required the
    bare canonical name (``langchain``) which is no longer imported
    when callers use only the split packages (``langchain_openai``,
    ``langchain_anthropic``); the LangChain detector silently
    missed every modern install and the per-event ``framework``
    field stayed null. Confirmed via Rule 40d smoke.
    """

    name: str = ""
    module: str | tuple[str, ...] = ""

    def detect(self) -> str | None:
        modules = (self.module,) if isinstance(self.module, str) else tuple(self.module)
        for mod_name in modules:
            mod = sys.modules.get(mod_name)
            if mod is None:
                continue
            version = getattr(mod, "__version__", None)
            return f"{self.name}/{version}" if version else self.name
        return None


class CrewAIClassifier(BaseClassifier):
    name = "crewai"
    module = "crewai"


class LangChainClassifier(BaseClassifier):
    # LangChain split into multiple packages around 0.2: the bare
    # ``langchain`` umbrella module isn't imported when callers use
    # only the per-provider packages (``langchain_openai``,
    # ``langchain_anthropic``, ``langchain_voyageai``, etc.).
    # ``langchain_core`` is the lowest common dependency and is
    # always present when any langchain_* package is loaded. Listing
    # multiple aliases collapses every install layout onto the bare
    # ``langchain`` framework name. Order matters: the first match
    # wins, so the umbrella module reports its version when present
    # and ``langchain_core`` is the canonical fallback.
    name = "langchain"
    module = ("langchain", "langchain_core")


class LangGraphClassifier(BaseClassifier):
    # LangGraph builds on LangChain and routes its LLM calls through
    # the same ChatAnthropic / ChatOpenAI abstractions, so the
    # existing patch() already intercepts LangGraph-driven calls.
    # This classifier exists so the session_start context accurately
    # reports LangGraph vs bare LangChain in the dashboard CONTEXT
    # panel and for framework analytics. See ARCHITECTURE.md.
    name = "langgraph"
    module = "langgraph"


class LlamaIndexClassifier(BaseClassifier):
    name = "llama_index"
    module = "llama_index"


class AutoGenClassifier(BaseClassifier):
    name = "autogen"
    module = "autogen"


class HaystackClassifier(BaseClassifier):
    name = "haystack"
    module = "haystack"


class DSPyClassifier(BaseClassifier):
    name = "dspy"
    module = "dspy"


class SmolAgentsClassifier(BaseClassifier):
    name = "smolagents"
    module = "smolagents"


class PydanticAIClassifier(BaseClassifier):
    name = "pydantic_ai"
    module = "pydantic_ai"


class FrameworkCollector(BaseCollector):
    CLASSIFIERS: list[BaseClassifier] = [
        CrewAIClassifier(),
        LangChainClassifier(),
        LangGraphClassifier(),
        LlamaIndexClassifier(),
        AutoGenClassifier(),
        HaystackClassifier(),
        DSPyClassifier(),
        SmolAgentsClassifier(),
        PydanticAIClassifier(),
    ]

    def _gather(self) -> dict[str, Any]:
        found = [c.detect() for c in self.CLASSIFIERS if c.detect() is not None]
        return {"frameworks": found} if found else {}


# ----------------------------------------------------------------------
# Top-level orchestrator
# ----------------------------------------------------------------------


PROCESS_COLLECTORS: list[BaseCollector] = [
    ProcessCollector(),
    OSCollector(),
    UserCollector(),
    PythonCollector(),
    GitCollector(),
]

ORCHESTRATION_COLLECTORS: list[BaseCollector] = [
    KubernetesCollector(),
    DockerComposeCollector(),
    DockerCollector(),
    AWSECSCollector(),
    CloudRunCollector(),
]

OTHER_COLLECTORS: list[BaseCollector] = [
    FrameworkCollector(),
]


def collect() -> dict[str, Any]:
    """Collect runtime context.

    Never raises. Returns only fields that were successfully gathered.
    The orchestration phase short-circuits at the first collector that
    applies (Kubernetes > Compose > Docker > ECS > Cloud Run) so the
    final dict has at most one ``orchestration`` field.
    """
    ctx: dict[str, Any] = {}

    for collector in PROCESS_COLLECTORS:
        try:
            if collector.applies():
                ctx.update(collector.collect())
        except Exception:
            pass

    for collector in ORCHESTRATION_COLLECTORS:
        try:
            if collector.applies():
                ctx.update(collector.collect())
                break
        except Exception:
            pass

    for collector in OTHER_COLLECTORS:
        try:
            if collector.applies():
                ctx.update(collector.collect())
        except Exception:
            pass

    return ctx
