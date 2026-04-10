"""Tests for the runtime context auto-collection module.

Covers the public ``collect()`` orchestrator and the individual
collectors. The collectors must never raise -- a broken collector is
silently dropped from the result. The orchestration phase must
short-circuit at the first matching collector so the final dict has
at most one ``orchestration`` field.
"""

from __future__ import annotations

import sys
from typing import TYPE_CHECKING, Any
from unittest.mock import patch

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

if TYPE_CHECKING:
    import pytest

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


def test_frameworks_never_imports() -> None:
    """If no framework is in sys.modules, the result is empty -- the
    classifier MUST NOT import anything new."""
    # Snapshot, drop every known framework module, run, then restore.
    snapshot = {}
    targets = [
        "crewai",
        "langchain",
        "llama_index",
        "autogen",
        "haystack",
        "dspy",
        "smolagents",
        "pydantic_ai",
    ]
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
