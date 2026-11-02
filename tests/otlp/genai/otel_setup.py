"""OpenTelemetry plumbing shared by the GenAI capture runners.

A runner is started by tests/otlp/record_genai.py with
``OTEL_EXPORTER_OTLP_ENDPOINT`` pointed at the local recorder and
``OTEL_EXPORTER_OTLP_PROTOCOL`` naming the encoding (``http/protobuf`` or
``http/json``). ``install`` sets the global tracer, logger and meter
providers with OTLP/HTTP exporters in that encoding; ``finish`` flushes
them and prints the line the driver reads back (package versions and how
the run ended).
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from importlib.metadata import PackageNotFoundError, version
from typing import Any

from opentelemetry import metrics, trace
from opentelemetry._logs import set_logger_provider
from opentelemetry.sdk._logs import LoggerProvider
from opentelemetry.sdk._logs.export import BatchLogRecordProcessor
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

# The line record_genai.py looks for on a runner's stdout.
RESULT_MARKER = "FD_GENAI_CAPTURE_RESULT "

# Metrics are exported once, when the run is flushed: a reader interval
# longer than any scenario keeps periodic exports out of the recording.
_METRIC_INTERVAL_MS = 600_000

# The packages whose versions a recording names, when installed.
_VERSIONED = (
    "pydantic-ai-slim",
    "strands-agents",
    "google-adk",
    "openai-agents",
    "opentelemetry-instrumentation-openai-agents-v2",
    "litellm",
    "openai",
    "anthropic",
    "opentelemetry-sdk",
    "opentelemetry-semantic-conventions",
    "opentelemetry-util-genai",
    "opentelemetry-exporter-otlp-proto-http",
    "opentelemetry-exporter-otlp-json-http",
)


def exporters() -> tuple[Any, Any, Any]:
    """Span, log and metric exporters in the encoding the environment names."""
    if os.environ.get("OTEL_EXPORTER_OTLP_PROTOCOL") == "http/json":
        from opentelemetry.exporter.otlp.json.http._log_exporter import (
            OTLPLogExporter,
        )
        from opentelemetry.exporter.otlp.json.http.metric_exporter import (
            OTLPMetricExporter,
        )
        from opentelemetry.exporter.otlp.json.http.trace_exporter import (
            OTLPSpanExporter,
        )
    else:
        from opentelemetry.exporter.otlp.proto.http._log_exporter import (
            OTLPLogExporter,
        )
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import (
            OTLPMetricExporter,
        )
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
            OTLPSpanExporter,
        )
    return OTLPSpanExporter(), OTLPLogExporter(), OTLPMetricExporter()


def install(
    resource: Resource | None = None, tracer_provider: TracerProvider | None = None
) -> Callable[[], None]:
    """Set the global providers, exporting to the recorder, and return the
    function that flushes and shuts them down. ``resource`` defaults to the
    SDK's (``service.name=unknown_service`` unless OTEL_SERVICE_NAME is
    set); a ``tracer_provider`` a framework built is given the span
    exporter instead of a new one."""
    resource = resource or Resource.create()
    spans, logs, metric = exporters()
    tracers = tracer_provider or TracerProvider(resource=resource)
    tracers.add_span_processor(BatchSpanProcessor(spans))
    if tracer_provider is None:
        trace.set_tracer_provider(tracers)
    loggers = LoggerProvider(resource=resource)
    loggers.add_log_record_processor(BatchLogRecordProcessor(logs))
    set_logger_provider(loggers)
    meters = MeterProvider(
        resource=resource,
        metric_readers=[
            PeriodicExportingMetricReader(
                metric, export_interval_millis=_METRIC_INTERVAL_MS
            )
        ],
    )
    metrics.set_meter_provider(meters)

    def flush() -> None:
        for provider in (tracers, loggers, meters):
            provider.force_flush()
        for provider in (tracers, loggers, meters):
            provider.shutdown()

    return flush


def flush_globals() -> None:
    """Flush and shut down whatever global providers a framework set."""
    from opentelemetry._logs import get_logger_provider

    for provider in (
        trace.get_tracer_provider(),
        get_logger_provider(),
        metrics.get_meter_provider(),
    ):
        for name in ("force_flush", "shutdown"):
            method = getattr(provider, name, None)
            if callable(method):
                method()


def versions() -> dict[str, str]:
    out = {}
    for name in _VERSIONED:
        try:
            out[name] = version(name)
        except PackageNotFoundError:
            continue
    return out


def finish(outcome: str, **details: Any) -> None:
    """Print the result line: the installed versions and how the run ended
    (``completed``, or the exception the framework raised)."""
    print(
        RESULT_MARKER
        + json.dumps({"versions": versions(), "outcome": outcome, **details}),
        flush=True,
    )
