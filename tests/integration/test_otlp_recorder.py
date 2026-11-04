"""The shared OTLP recorder cleans what it writes and refuses what it
cannot clean.

tests/otlp/recorder.py writes every recorded fixture (record_claude_code.py,
record_genai.py). These tests run its cleaning and its refusals on
requests built here: no exporter, model or network is involved. The
recorder needs opentelemetry-proto, which the sensor's dev dependencies
bring; where it is missing this module is skipped.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

pytest.importorskip("opentelemetry.proto")

from google.protobuf import field_mask_pb2  # noqa: E402
from google.protobuf.descriptor import FieldDescriptor  # noqa: E402
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (  # noqa: E402
    ExportTraceServiceRequest,
)

from ..otlp import recorder  # noqa: E402


def _request(*values: str) -> dict[str, Any]:
    """A recorded protobuf trace export with one span per value, holding
    it as a string attribute and inside an array attribute."""
    msg = ExportTraceServiceRequest()
    scope = msg.resource_spans.add().scope_spans.add()
    for i, value in enumerate(values):
        span = scope.spans.add()
        span.trace_id = bytes([1]) * 16
        span.span_id = bytes([i + 2]) * 8
        span.name = "probe"
        span.start_time_unix_nano = 1
        span.end_time_unix_nano = 2
        note = span.attributes.add()
        note.key = "note"
        note.value.string_value = value
        notes = span.attributes.add()
        notes.key = "notes"
        notes.value.array_value.values.add().string_value = value
    return {
        "path": "/v1/traces",
        "content_type": "application/x-protobuf",
        "content_encoding": None,
        "body": msg.SerializeToString(),
    }


def _strings(out_dir: Path) -> list[str]:
    """Every string attribute value of a written scenario's spans."""
    msg = ExportTraceServiceRequest.FromString((out_dir / "001-traces.pb").read_bytes())
    found = []
    for resource in msg.resource_spans:
        for scope in resource.scope_spans:
            for span in scope.spans:
                for attr in span.attributes:
                    found.append(attr.value.string_value)
                    found += [v.string_value for v in attr.value.array_value.values]
    return [s for s in found if s]


def test_repeated_fields_are_read_on_every_protobuf_release() -> None:
    """protobuf 7 dropped FieldDescriptor.label for is_repeated, and 5.x
    has no is_repeated: the recorder reads whichever the release has."""
    assert recorder._is_repeated(SimpleNamespace(is_repeated=True))
    assert not recorder._is_repeated(SimpleNamespace(is_repeated=False))
    assert recorder._is_repeated(SimpleNamespace(label=FieldDescriptor.LABEL_REPEATED))
    assert not recorder._is_repeated(
        SimpleNamespace(label=FieldDescriptor.LABEL_OPTIONAL)
    )


def test_cleaning_reaches_repeated_strings_and_messages(tmp_path: Path) -> None:
    """With the installed protobuf's own descriptors, a path is scrubbed in
    repeated messages (spans, attributes, array values) and in repeated
    strings."""
    work = tmp_path / "work"
    scrub = recorder.scrubber(work)
    out = tmp_path / "out"
    recorder.write_scenario(
        [_request(f"{work}/a", f"{work}/b")], out, {"scenario": "probe"}, scrub
    )
    assert _strings(out) == ["/home/user/project/a"] * 2 + ["/home/user/project/b"] * 2
    mask = field_mask_pb2.FieldMask(paths=[f"{work}/c", f"{work}/d"])
    recorder._clean_pb_tree(mask, scrub)
    assert list(mask.paths) == ["/home/user/project/c", "/home/user/project/d"]


def test_a_dashed_checkout_path_is_scrubbed(tmp_path: Path) -> None:
    """This repository's path in the dashed form a Claude Code project
    directory takes is replaced, like the plain path."""
    dashed = recorder.dashed(recorder.REPO)
    out = tmp_path / "out"
    recorder.write_scenario(
        [_request(f"/home/user/.claude/projects/{dashed}/session.jsonl")],
        out,
        {"scenario": "probe"},
        recorder.scrubber(tmp_path / "work"),
    )
    assert (
        _strings(out)
        == ["/home/user/.claude/projects/-home-user-flightdeck/session.jsonl"] * 2
    )


def test_a_scenario_naming_this_machine_is_not_written(tmp_path: Path) -> None:
    """The host name, the user name or a checkout's dashed path in a form
    the scrubbing does not replace (here upper case) makes the recorder
    refuse the scenario and remove what it wrote."""
    names = recorder.machine_values()
    assert any(label.startswith("the checkout path") for label in names), names
    for i, (label, value) in enumerate(names.items()):
        out = tmp_path / f"out-{i}"
        with pytest.raises(SystemExit) as refused:
            recorder.write_scenario(
                [_request(f"ran on {value.upper()} today")],
                out,
                {"scenario": "probe"},
                recorder.scrubber(tmp_path / "work"),
            )
        assert label in str(refused.value)
        assert not out.exists()


def test_a_scenario_holding_a_credential_of_the_environment_is_not_written(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A value of a credential-named environment variable, even one no
    credential pattern knows, is refused, and the refusal never repeats it."""
    secret = "probe-" + "q7" * 15
    monkeypatch.setenv("FD_RECORDER_PROBE_API_KEY", secret)
    out = tmp_path / "out"
    with pytest.raises(SystemExit) as refused:
        recorder.write_scenario(
            [_request(f"x {secret} y")],
            out,
            {"scenario": "probe"},
            recorder.scrubber(tmp_path / "work"),
        )
    assert "credential" in str(refused.value)
    assert secret not in str(refused.value)
    assert not out.exists()


def test_a_manifest_naming_this_machine_is_not_written(tmp_path: Path) -> None:
    """What a driver puts in the manifest (provider_calls among it) is
    checked like the request files: a host name, a home directory or an
    account id there makes the recorder refuse the scenario."""
    planted = {
        "home directory": [{"path": "/home/alice/repo"}],
        "account id": [{"error": {"code": "org-" + "Ab1" * 8}}],
    }
    for label, value in recorder.machine_values().items():
        if label.startswith("the host name"):
            planted[label] = [{"path": f"/v1/{value}"}]
    for i, (what, calls) in enumerate(planted.items()):
        out = tmp_path / f"out-{i}"
        with pytest.raises(SystemExit) as refused:
            recorder.write_scenario(
                [_request("fine")],
                out,
                {"scenario": "probe", "provider_calls": calls},
                recorder.scrubber(tmp_path / "work"),
            )
        assert "manifest.json" in str(refused.value), what
        assert not out.exists(), what
