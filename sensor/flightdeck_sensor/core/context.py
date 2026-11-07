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
- Framework classifiers inspect ``sys.modules`` and installed package
  metadata only. They never import anything new -- a framework not
  loaded when they run is not claimed. The session runs them again for
  a framework the agent imports after ``init()`` (its late framework
  detection).
- No network calls, no shell-outs longer than 500 ms, no writes to
  the user's filesystem.
"""

from __future__ import annotations

import importlib.metadata
import os
import platform
import re
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any, Protocol

# Subprocess timeout for ``git`` invocations in GitCollector.
# Bounded so a slow / unresponsive git binary cannot delay sensor
# init() — context collection is best-effort and falls back silently.
_GIT_SUBPROCESS_TIMEOUT_SECS = 0.5

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
            result["process_name"] = Path(argv0).name
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
        user = os.environ.get("USER") or os.environ.get("USERNAME") or os.environ.get("LOGNAME")
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
                timeout=_GIT_SUBPROCESS_TIMEOUT_SECS,
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
            repo = Path(clean.rstrip("/")).name
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
        return bool(os.environ.get("COMPOSE_PROJECT_NAME") or os.environ.get("COMPOSE_SERVICE"))

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
        return Path("/.dockerenv").exists()

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
            result["ecs_task"] = Path(task).name
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

# Distribution versions already looked up, by distribution name (None when
# it is not installed). A lookup reads dist-info files from every sys.path
# entry, so each name is read once per process.
_DIST_VERSIONS: dict[str, str | None] = {}


def _distribution_version(name: str) -> str | None:
    """The installed version of distribution ``name``, or None. Reads
    package metadata only; never imports the package."""
    if name in _DIST_VERSIONS:
        return _DIST_VERSIONS[name]
    version: str | None
    try:
        version = importlib.metadata.version(name) or None
    except Exception:
        # PackageNotFoundError, or a broken dist-info: no version.
        version = None
    _DIST_VERSIONS[name] = version
    return version


def framework_label(entry: object) -> str | None:
    """The bare label of a ``context.frameworks[]`` entry
    (``langchain/0.3.27`` -> ``langchain``); None for a non-string or
    empty entry."""
    if not isinstance(entry, str):
        return None
    return entry.split("/", 1)[0] or None


def module_count() -> int:
    """How many modules are loaded. The late framework detection runs the
    classifiers again only when this has changed."""
    return len(sys.modules)


class BaseClassifier:
    """Inspects ``sys.modules`` for a known framework. Never imports.

    ``module`` may be a single module name (``"langchain"``) or a
    list/tuple of module names. When multiple are listed they're
    treated as aliases — any one being in ``sys.modules`` is enough
    to consider the framework present, and the detected version
    comes from the first match. Requiring only the bare canonical
    name (``langchain``) would miss callers that import just the
    split packages (``langchain_openai``, ``langchain_anthropic``):
    the LangChain detector silently missed every modern install and
    the per-event ``framework`` field stayed null. Confirmed via
    Rule 40d smoke.

    ``distributions`` names the PyPI distributions that install the
    framework. The first one installed gives the version when the module
    has no ``__version__``. With ``requires_distribution`` the framework
    counts as present only when one of them is installed, for an import
    name generic enough that an application's own package could carry it.
    """

    name: str = ""
    module: str | tuple[str, ...] = ""
    distributions: tuple[str, ...] = ()
    requires_distribution: bool = False

    def _installed_version(self) -> str | None:
        for dist in self.distributions:
            version = _distribution_version(dist)
            if version:
                return version
        return None

    def _loaded(self) -> Any:
        modules = (self.module,) if isinstance(self.module, str) else tuple(self.module)
        for mod_name in modules:
            mod = sys.modules.get(mod_name)
            if mod is not None:
                return mod
        return None

    @staticmethod
    def _entry(name: str, version: object) -> str:
        return f"{name}/{version}" if isinstance(version, str) and version else name

    def detect(self) -> str | None:
        mod = self._loaded()
        if mod is None:
            return None
        if self.requires_distribution and self._installed_version() is None:
            return None
        version = getattr(mod, "__version__", None)
        if not isinstance(version, str) or not version:
            version = self._installed_version()
        return self._entry(self.name, version)


class DeepAgentsClassifier(BaseClassifier):
    # LangChain's Deep Agents is built on LangGraph and LangChain, so it
    # comes before both.
    name = "deepagents"
    module = "deepagents"
    distributions = ("deepagents",)


class CrewAIClassifier(BaseClassifier):
    name = "crewai"
    module = "crewai"
    distributions = ("crewai",)


class GoogleADKClassifier(BaseClassifier):
    # ADK sends its model calls through google-genai, a provider SDK and
    # not a framework, so the ADK label is what a session reports.
    name = "google_adk"
    module = "google.adk"
    distributions = ("google-adk",)


class OpenAIAgentsClassifier(BaseClassifier):
    # The OpenAI Agents SDK's import name is ``agents``, which an
    # application's own package may also be called: it counts only with
    # the openai-agents distribution installed.
    name = "openai_agents"
    module = "agents"
    distributions = ("openai-agents",)
    requires_distribution = True


class AgentFrameworkClassifier(BaseClassifier):
    # Microsoft Agent Framework, the successor to AutoGen and to Semantic
    # Kernel's agents.
    name = "agent_framework"
    module = "agent_framework"
    distributions = ("agent-framework-core", "agent-framework")


class SemanticKernelClassifier(BaseClassifier):
    name = "semantic_kernel"
    module = "semantic_kernel"
    distributions = ("semantic-kernel",)


class AutoGenClassifier(BaseClassifier):
    # Microsoft's AutoGen from 0.4 on. Its import names are
    # ``autogen_agentchat`` and ``autogen_core``; the ``autogen`` import
    # name is AG2's (AG2Classifier).
    name = "autogen"
    module = ("autogen_agentchat", "autogen_core")
    distributions = ("autogen-agentchat", "autogen-core")


# The distributions that install AG2 under the ``autogen`` import name.
_AG2_DISTRIBUTIONS = ("ag2", "pyautogen", "autogen")
# Microsoft's distribution whose 0.2 maintenance line also installs the
# ``autogen`` import name; from 0.4 on it installs ``autogen_agentchat``.
_AUTOGEN_LEGACY_DISTRIBUTION = "autogen-agentchat"
# The autogen-agentchat release that moved to the ``autogen_agentchat``
# import name.
_AUTOGEN_AGENTCHAT_MODULE_RELEASE = (0, 4)


def _version_below(version: str, bound: tuple[int, int]) -> bool:
    """Whether ``version``'s major.minor is below ``bound``; False when
    it does not start with two integers."""
    match = re.match(r"(\d+)\.(\d+)", version)
    if match is None:
        return False
    return (int(match.group(1)), int(match.group(2))) < bound


class AG2Classifier(BaseClassifier):
    # AG2 owns the ``autogen`` import name: the ag2, pyautogen and autogen
    # distributions all install it. Microsoft's autogen-agentchat below
    # 0.4 installs it too; with no AG2 distribution present that is
    # Microsoft's AutoGen 0.2 and reports ``autogen``.
    name = "ag2"
    module = "autogen"
    distributions = _AG2_DISTRIBUTIONS

    def detect(self) -> str | None:
        mod = self._loaded()
        if mod is None:
            return None
        ag2_version = self._installed_version()
        if ag2_version is None:
            legacy = _distribution_version(_AUTOGEN_LEGACY_DISTRIBUTION)
            if legacy is not None and _version_below(legacy, _AUTOGEN_AGENTCHAT_MODULE_RELEASE):
                return self._entry(AutoGenClassifier.name, legacy)
        version = getattr(mod, "__version__", None)
        if not isinstance(version, str) or not version:
            version = ag2_version
        return self._entry(self.name, version)


class AgnoClassifier(BaseClassifier):
    name = "agno"
    module = "agno"
    distributions = ("agno",)


class StrandsClassifier(BaseClassifier):
    name = "strands"
    module = "strands"
    distributions = ("strands-agents",)


class PydanticAIClassifier(BaseClassifier):
    name = "pydantic_ai"
    module = "pydantic_ai"
    distributions = ("pydantic-ai-slim", "pydantic-ai")


class SmolAgentsClassifier(BaseClassifier):
    name = "smolagents"
    module = "smolagents"
    distributions = ("smolagents",)


class ClaudeAgentSDKClassifier(BaseClassifier):
    name = "claude_agent_sdk"
    module = "claude_agent_sdk"
    distributions = ("claude-agent-sdk",)


class LlamaIndexClassifier(BaseClassifier):
    name = "llama_index"
    module = "llama_index"
    distributions = ("llama-index-core",)


class HaystackClassifier(BaseClassifier):
    name = "haystack"
    module = "haystack"
    distributions = ("haystack-ai",)


class DSPyClassifier(BaseClassifier):
    name = "dspy"
    module = "dspy"
    distributions = ("dspy",)


class LangGraphClassifier(BaseClassifier):
    # LangGraph builds on LangChain and routes its LLM calls through
    # the same ChatAnthropic / ChatOpenAI abstractions, so the
    # existing patch() already intercepts LangGraph-driven calls.
    # This classifier exists so the session reports LangGraph rather
    # than bare LangChain in the dashboard CONTEXT panel and for
    # framework analytics; it comes before LangChain for that reason.
    name = "langgraph"
    module = "langgraph"
    distributions = ("langgraph",)


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
    # and ``langchain_core`` is the canonical fallback. Many frameworks
    # embed LangChain, so it is the last classifier.
    name = "langchain"
    module = ("langchain", "langchain_core")
    distributions = ("langchain", "langchain-core")


class FrameworkCollector(BaseCollector):
    # The order the per-event ``framework`` label is taken in: the first
    # match wins, and a framework comes before the ones it is built on or
    # commonly embeds. ARCHITECTURE.md (Sensor > Framework attribution)
    # lists it.
    CLASSIFIERS: list[BaseClassifier] = [
        DeepAgentsClassifier(),
        CrewAIClassifier(),
        GoogleADKClassifier(),
        OpenAIAgentsClassifier(),
        AgentFrameworkClassifier(),
        SemanticKernelClassifier(),
        AutoGenClassifier(),
        AG2Classifier(),
        AgnoClassifier(),
        StrandsClassifier(),
        PydanticAIClassifier(),
        SmolAgentsClassifier(),
        ClaudeAgentSDKClassifier(),
        LlamaIndexClassifier(),
        HaystackClassifier(),
        DSPyClassifier(),
        LangGraphClassifier(),
        LangChainClassifier(),
    ]

    def _gather(self) -> dict[str, Any]:
        found = detect_frameworks()
        return {"frameworks": found} if found else {}


def detect_frameworks() -> list[str]:
    """Every known framework loaded now, versioned where a version is
    known, in classifier order. Never raises; a broken classifier is
    skipped."""
    found: list[str] = []
    for classifier in FrameworkCollector.CLASSIFIERS:
        try:
            entry = classifier.detect()
        except Exception:
            # best-effort: one classifier must not hide the others.
            continue
        if entry is not None and entry not in found:
            found.append(entry)
    return found


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
            # best-effort: a single broken collector must never crash init().
            pass

    for collector in ORCHESTRATION_COLLECTORS:
        try:
            if collector.applies():
                ctx.update(collector.collect())
                break
        except Exception:
            # best-effort: a single broken collector must never crash init().
            pass

    for collector in OTHER_COLLECTORS:
        try:
            if collector.applies():
                ctx.update(collector.collect())
        except Exception:
            # best-effort: a single broken collector must never crash init().
            pass

    return ctx
