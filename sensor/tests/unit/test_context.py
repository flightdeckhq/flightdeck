"""Tests for the runtime context auto-collection module.

Covers the public ``collect()`` orchestrator and the individual
collectors. The collectors must never raise -- a broken collector is
silently dropped from the result. The orchestration phase must
short-circuit at the first matching collector so the final dict has
at most one ``orchestration`` field.
"""

from __future__ import annotations

import sys
import types
from typing import Any
from unittest.mock import patch

import pytest

from flightdeck_sensor.core import context
from flightdeck_sensor.core.context import (
    AWSECSCollector,
    BaseCollector,
    CloudRunCollector,
    DockerCollector,
    DockerComposeCollector,
    FrameworkCollector,
    GitCollector,
    KubernetesCollector,
    OSCollector,
    ProcessCollector,
    PythonCollector,
    UserCollector,
    collect,
)

# ----------------------------------------------------------------------
# Top-level collect()
# ----------------------------------------------------------------------


def test_collect_returns_dict() -> None:
    result = collect()
    assert isinstance(result, dict)


def test_collect_has_hostname() -> None:
    result = collect()
    assert "hostname" in result
    assert isinstance(result["hostname"], str)
    assert result["hostname"] != ""


def test_collect_has_pid() -> None:
    result = collect()
    assert "pid" in result
    assert isinstance(result["pid"], int)
    assert result["pid"] > 0


def test_collect_has_os() -> None:
    result = collect()
    assert "os" in result
    assert isinstance(result["os"], str)


def test_collect_has_python_version() -> None:
    result = collect()
    assert "python_version" in result
    assert isinstance(result["python_version"], str)
    # platform.python_version() always has the form "X.Y.Z".
    assert result["python_version"].count(".") >= 1


def test_collect_never_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    """A broken collector must not propagate exceptions to callers."""

    class Broken(BaseCollector):
        def applies(self) -> bool:
            return True

        def _gather(self) -> dict[str, Any]:  # pragma: no cover - exercised via collect()
            raise RuntimeError("boom")

    # Inject a broken collector at the top of every phase. The two-layer
    # try/except (BaseCollector.collect + outer collect orchestrator)
    # should swallow the failure cleanly.
    monkeypatch.setattr(
        context,
        "PROCESS_COLLECTORS",
        [Broken(), *context.PROCESS_COLLECTORS],
    )
    monkeypatch.setattr(
        context,
        "ORCHESTRATION_COLLECTORS",
        [Broken(), *context.ORCHESTRATION_COLLECTORS],
    )
    monkeypatch.setattr(
        context,
        "OTHER_COLLECTORS",
        [Broken(), *context.OTHER_COLLECTORS],
    )

    result = collect()
    assert isinstance(result, dict)
    # Even with the broken collectors, valid fields still come through.
    assert "hostname" in result


# ----------------------------------------------------------------------
# Orchestration collectors
# ----------------------------------------------------------------------


def test_kubernetes_detected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
    monkeypatch.setenv("MY_POD_NAMESPACE", "agents")
    monkeypatch.setenv("MY_NODE_NAME", "node-1")
    monkeypatch.setenv("MY_POD_NAME", "agent-pod-7")

    result = KubernetesCollector().collect()
    assert result["orchestration"] == "kubernetes"
    assert result["k8s_namespace"] == "agents"
    assert result["k8s_node"] == "node-1"
    assert result["k8s_pod"] == "agent-pod-7"


def test_compose_detected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("COMPOSE_PROJECT_NAME", "fleet")
    monkeypatch.setenv("COMPOSE_SERVICE", "worker")

    result = DockerComposeCollector().collect()
    assert result["orchestration"] == "docker-compose"
    assert result["compose_project"] == "fleet"
    assert result["compose_service"] == "worker"


def test_k8s_priority_over_compose(monkeypatch: pytest.MonkeyPatch) -> None:
    """Both env signals present -- k8s wins, compose is skipped entirely."""
    monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
    monkeypatch.setenv("MY_POD_NAMESPACE", "agents")
    monkeypatch.setenv("COMPOSE_PROJECT_NAME", "fleet")
    monkeypatch.setenv("COMPOSE_SERVICE", "worker")

    result = collect()
    assert result["orchestration"] == "kubernetes"
    assert result.get("k8s_namespace") == "agents"
    # compose_* fields must NOT appear -- the orchestration phase
    # broke after the first match.
    assert "compose_project" not in result
    assert "compose_service" not in result


def test_aws_ecs_detected(monkeypatch: pytest.MonkeyPatch) -> None:
    # Make sure higher-priority collectors don't fire.
    monkeypatch.delenv("KUBERNETES_SERVICE_HOST", raising=False)
    monkeypatch.delenv("COMPOSE_PROJECT_NAME", raising=False)
    monkeypatch.delenv("COMPOSE_SERVICE", raising=False)
    monkeypatch.setenv(
        "ECS_CONTAINER_METADATA_URI_V4",
        "http://169.254.170.2/v4/metadata",
    )
    monkeypatch.setenv("ECS_TASK_DEFINITION", "arn:aws:ecs:task/agents:42")

    result = AWSECSCollector().collect()
    assert result["orchestration"] == "aws-ecs"
    assert result["ecs_task"] == "agents:42"


def test_cloud_run_detected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("K_SERVICE", "agent-svc")
    monkeypatch.setenv("K_REVISION", "agent-svc-00007-abc")

    result = CloudRunCollector().collect()
    assert result["orchestration"] == "cloud-run"
    assert result["cloud_run_service"] == "agent-svc"
    assert result["cloud_run_revision"] == "agent-svc-00007-abc"


# ----------------------------------------------------------------------
# Git collector
# ----------------------------------------------------------------------


def test_git_credentials_stripped() -> None:
    """A remote URL with embedded credentials must never make it into the
    extracted repo name."""
    collector = GitCollector()
    with patch.object(
        collector,
        "_run",
        side_effect=lambda *args: {
            ("rev-parse", "--short", "HEAD"): "abc1234",
            ("branch", "--show-current"): "main",
            ("remote", "get-url", "origin"): (
                "https://user:secret-token@github.com/acme/flightdeck.git"
            ),
        }.get(args),
    ):
        result = collector.collect()

    assert result["git_commit"] == "abc1234"
    assert result["git_branch"] == "main"
    assert result["git_repo"] == "flightdeck"
    # The credentials must NOT appear anywhere in any returned value.
    blob = " ".join(str(v) for v in result.values())
    assert "secret-token" not in blob
    assert "user:" not in blob


def test_git_missing_returns_empty() -> None:
    """No git binary / not a repo -- collector returns an empty dict,
    never raises."""
    collector = GitCollector()
    with patch.object(collector, "_run", return_value=None):
        result = collector.collect()
    assert result == {}


# ----------------------------------------------------------------------
# Framework classifier
# ----------------------------------------------------------------------


def test_frameworks_detected(monkeypatch: pytest.MonkeyPatch) -> None:
    """A loaded framework module is reported with its version."""
    fake = type(sys)("crewai")
    fake.__version__ = "0.42.0"  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "crewai", fake)

    result = FrameworkCollector().collect()
    assert "frameworks" in result
    assert "crewai/0.42.0" in result["frameworks"]


def test_frameworks_no_version(monkeypatch: pytest.MonkeyPatch) -> None:
    """A framework with no __version__ attribute is reported by name only."""
    fake = type(sys)("haystack")
    monkeypatch.setitem(sys.modules, "haystack", fake)

    result = FrameworkCollector().collect()
    assert "haystack" in result["frameworks"]


def test_langgraph_detected(monkeypatch: pytest.MonkeyPatch) -> None:
    """LangGraph loaded into sys.modules is reported by the
    LangGraphClassifier so session_start.context.frameworks
    distinguishes LangGraph-driven agents from bare LangChain."""
    fake = type(sys)("langgraph")
    fake.__version__ = "1.1.6"  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "langgraph", fake)

    result = FrameworkCollector().collect()
    assert "langgraph/1.1.6" in result["frameworks"]


def test_frameworks_never_imports() -> None:
    """If no framework is in sys.modules, the result is empty -- the
    classifier MUST NOT import anything new."""
    # Snapshot, drop every known framework module (every alias a
    # classifier accepts, e.g. ``langchain_core`` for LangChain's split
    # packages), run, then restore.
    snapshot = {}
    targets = _classifier_modules()
    for name in targets:
        if name in sys.modules:
            snapshot[name] = sys.modules.pop(name)
    try:
        result = FrameworkCollector().collect()
        assert result == {}
        # And the modules are still not in sys.modules -- nothing was
        # imported by the collector.
        for name in targets:
            assert name not in sys.modules
    finally:
        sys.modules.update(snapshot)


def _classifier_modules() -> list[str]:
    names: list[str] = []
    for classifier in FrameworkCollector.CLASSIFIERS:
        module = classifier.module
        names.extend((module,) if isinstance(module, str) else module)
    return names


def _fake(name: str, version: str | None = None) -> types.ModuleType:
    mod = types.ModuleType(name)
    if version is not None:
        mod.__version__ = version  # type: ignore[attr-defined]
    return mod


def _only(
    monkeypatch: pytest.MonkeyPatch,
    modules: dict[str, Any],
    dists: dict[str, str] | None = None,
) -> None:
    """The classifiers see exactly ``modules`` loaded and ``dists``
    installed, whatever the test process has imported or installed."""
    monkeypatch.setattr(context, "sys", types.SimpleNamespace(argv=sys.argv, modules=modules))
    installed = dists or {}
    monkeypatch.setattr(context, "_distribution_version", installed.get)


# Each classifier: the module that loads it, and its label. The labels of
# the four frameworks the OTLP GenAI dialect maps are the dialect's
# (ingestion/internal/genai/source.go), so sensor and OTLP rows share an
# analytics bucket.
_CLASSIFIER_CASES = [
    ("deepagents", "deepagents"),
    ("crewai", "crewai"),
    ("google.adk", "google_adk"),
    ("agent_framework", "agent_framework"),
    ("semantic_kernel", "semantic_kernel"),
    ("autogen_agentchat", "autogen"),
    ("autogen_core", "autogen"),
    ("autogen", "ag2"),
    ("agno", "agno"),
    ("strands", "strands"),
    ("pydantic_ai", "pydantic_ai"),
    ("smolagents", "smolagents"),
    ("claude_agent_sdk", "claude_agent_sdk"),
    ("llama_index", "llama_index"),
    ("haystack", "haystack"),
    ("dspy", "dspy"),
    ("langgraph", "langgraph"),
    ("langchain", "langchain"),
    ("langchain_core", "langchain"),
]


@pytest.mark.parametrize(("module", "label"), _CLASSIFIER_CASES)
def test_each_classifier_reports_its_label_and_version(
    monkeypatch: pytest.MonkeyPatch, module: str, label: str
) -> None:
    _only(monkeypatch, {module: _fake(module, "9.1.0")})
    assert FrameworkCollector().collect() == {"frameworks": [f"{label}/9.1.0"]}


def test_the_genai_dialect_labels_are_the_sensors() -> None:
    """The four labels the OTLP GenAI receiver stamps are classifier
    labels too."""
    labels = {c.name for c in FrameworkCollector.CLASSIFIERS}
    assert {"google_adk", "openai_agents", "strands", "pydantic_ai"} <= labels


def test_a_module_without_a_version_takes_its_distributions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Strands has no ``__version__``: the strands-agents distribution's
    version is reported."""
    _only(monkeypatch, {"strands": _fake("strands")}, {"strands-agents": "1.63.0"})
    assert FrameworkCollector().collect() == {"frameworks": ["strands/1.63.0"]}


def test_a_module_with_neither_version_reports_the_bare_label(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _only(monkeypatch, {"agno": _fake("agno")})
    assert FrameworkCollector().collect() == {"frameworks": ["agno"]}


def test_openai_agents_counts_only_with_its_distribution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """``agents`` is a generic import name; an application's own
    ``agents`` package is not the OpenAI Agents SDK."""
    _only(monkeypatch, {"agents": _fake("agents", "0.24.0")})
    assert FrameworkCollector().collect() == {}
    _only(monkeypatch, {"agents": _fake("agents", "0.24.0")}, {"openai-agents": "0.24.0"})
    assert FrameworkCollector().collect() == {"frameworks": ["openai_agents/0.24.0"]}


@pytest.mark.parametrize("dist", ["ag2", "pyautogen", "autogen"])
def test_the_autogen_import_name_is_ag2(monkeypatch: pytest.MonkeyPatch, dist: str) -> None:
    """Every AG2 distribution installs the ``autogen`` import name."""
    _only(monkeypatch, {"autogen": _fake("autogen")}, {dist: "0.10.2"})
    assert FrameworkCollector().collect() == {"frameworks": ["ag2/0.10.2"]}


def test_microsofts_autogen_02_line_is_autogen(monkeypatch: pytest.MonkeyPatch) -> None:
    """autogen-agentchat below 0.4 installs ``autogen`` too; with no AG2
    distribution that is Microsoft's AutoGen."""
    _only(monkeypatch, {"autogen": _fake("autogen")}, {"autogen-agentchat": "0.2.40"})
    assert FrameworkCollector().collect() == {"frameworks": ["autogen/0.2.40"]}


def test_ag2_wins_the_autogen_import_name_when_both_are_installed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With Microsoft's 0.4+ AutoGen and AG2 side by side, each is its own
    entry, and an AG2 distribution keeps ``autogen`` as AG2."""
    _only(
        monkeypatch,
        {
            "autogen": _fake("autogen", "0.10.2"),
            "autogen_agentchat": _fake("autogen_agentchat", "0.7.5"),
        },
        {"ag2": "0.10.2", "autogen-agentchat": "0.7.5"},
    )
    assert FrameworkCollector().collect() == {"frameworks": ["autogen/0.7.5", "ag2/0.10.2"]}


def test_autogen_without_any_metadata_is_ag2(monkeypatch: pytest.MonkeyPatch) -> None:
    """AG2 owns the import name, so an ``autogen`` with no distribution
    metadata at all is AG2."""
    _only(monkeypatch, {"autogen": _fake("autogen")})
    assert FrameworkCollector().collect() == {"frameworks": ["ag2"]}


@pytest.mark.parametrize(
    ("loaded", "first"),
    [
        # Deep Agents is built on LangGraph, which is built on LangChain.
        (["langchain_core", "langgraph", "deepagents"], "deepagents"),
        (["langchain_core", "langgraph"], "langgraph"),
        # ADK, not the google-genai transport it calls models through.
        (["google.adk", "google.genai"], "google_adk"),
        # An agent framework before the libraries it embeds.
        (["llama_index", "crewai"], "crewai"),
        (["langchain_core", "pydantic_ai"], "pydantic_ai"),
        (["semantic_kernel", "agent_framework"], "agent_framework"),
    ],
)
def test_a_framework_comes_before_the_ones_it_builds_on(
    monkeypatch: pytest.MonkeyPatch, loaded: list[str], first: str
) -> None:
    _only(monkeypatch, {name: _fake(name) for name in loaded})
    found = FrameworkCollector().collect()["frameworks"]
    assert found[0] == first


def test_a_broken_classifier_does_not_hide_the_others(monkeypatch: pytest.MonkeyPatch) -> None:
    class Broken(context.BaseClassifier):
        def detect(self) -> str | None:
            raise RuntimeError("boom")

    _only(monkeypatch, {"dspy": _fake("dspy", "3.4.0")})
    monkeypatch.setattr(
        FrameworkCollector, "CLASSIFIERS", [Broken(), *FrameworkCollector.CLASSIFIERS]
    )
    assert FrameworkCollector().collect() == {"frameworks": ["dspy/3.4.0"]}


def test_distribution_versions_are_read_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """A metadata lookup reads dist-info files; each name is read once per
    process, a missing distribution included."""
    calls: list[str] = []

    def fake_version(name: str) -> str:
        calls.append(name)
        if name == "missing-dist":
            raise context.importlib.metadata.PackageNotFoundError(name)
        return "1.2.3"

    monkeypatch.setattr(context, "_DIST_VERSIONS", {})
    monkeypatch.setattr(context.importlib.metadata, "version", fake_version)
    assert context._distribution_version("some-dist") == "1.2.3"
    assert context._distribution_version("some-dist") == "1.2.3"
    assert context._distribution_version("missing-dist") is None
    assert context._distribution_version("missing-dist") is None
    assert calls == ["some-dist", "missing-dist"]


def test_framework_label_strips_the_version() -> None:
    assert context.framework_label("langchain/0.3.27") == "langchain"
    assert context.framework_label("agno") == "agno"
    assert context.framework_label("") is None
    assert context.framework_label(None) is None


# ----------------------------------------------------------------------
# Individual base collectors
# ----------------------------------------------------------------------


def test_os_collector_fields() -> None:
    result = OSCollector().collect()
    assert set(result.keys()) >= {"os", "arch", "hostname"}


def test_process_collector_fields() -> None:
    result = ProcessCollector().collect()
    assert "pid" in result


def test_python_collector_fields() -> None:
    result = PythonCollector().collect()
    assert "python_version" in result


def test_user_collector_with_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("USER", "alice")
    result = UserCollector().collect()
    assert result == {"user": "alice"}


def test_user_collector_without_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("USER", raising=False)
    monkeypatch.delenv("USERNAME", raising=False)
    monkeypatch.delenv("LOGNAME", raising=False)
    result = UserCollector().collect()
    assert result == {}


def test_docker_collector_no_dockerenv(monkeypatch: pytest.MonkeyPatch) -> None:
    """Outside a container, /.dockerenv does not exist and the collector
    is skipped (applies() returns False)."""
    import os.path

    real_exists = os.path.exists
    monkeypatch.setattr(
        "os.path.exists",
        lambda p: False if p == "/.dockerenv" else real_exists(p),
    )
    assert DockerCollector().applies() is False
