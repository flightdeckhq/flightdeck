"""Unit tests for the CrewAI + mcpadapt schema-fixup compat helper.

The helper exists to strip JSON-Schema-2020-12-invalid keys from each
CrewAI tool's ``args_schema`` Pydantic class so OpenAI / Anthropic
APIs accept the resulting tool-call payload. Tests cover the cleaning
matrix per Step 6.5 spec plus the agent-level integration shape.

No real crewai or mcpadapt imports needed — the module's public API
operates on duck-typed ``agent.tools[].args_schema`` instances; tests
hand it minimal fakes that mirror the relevant Pydantic surface.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import BaseModel

from flightdeck_sensor.compat.crewai_mcp import (
    _clean_schema_dict,
    crewai_mcp_schema_fixup,
)


# ---------------------------------------------------------------------
# Schema-cleaning matrix
# ---------------------------------------------------------------------


def test_empty_anyof_array_is_dropped() -> None:
    schema = {
        "type": "object",
        "properties": {
            "text": {"anyOf": [], "type": "string"},
        },
    }
    cleaned = _clean_schema_dict(schema)
    assert "anyOf" not in cleaned["properties"]["text"]
    assert cleaned["properties"]["text"]["type"] == "string"


def test_clean_schema_passes_valid_schema_through_unchanged() -> None:
    schema = {
        "type": "object",
        "properties": {
            "text": {"type": "string"},
            "n": {"type": "integer"},
        },
        "required": ["text"],
        "additionalProperties": False,
    }
    cleaned = _clean_schema_dict(schema)
    assert cleaned == schema


def test_null_enum_is_dropped() -> None:
    schema = {"type": "string", "enum": None}
    cleaned = _clean_schema_dict(schema)
    assert "enum" not in cleaned
    assert cleaned["type"] == "string"


def test_null_items_is_dropped() -> None:
    schema = {"type": "array", "items": None}
    cleaned = _clean_schema_dict(schema)
    assert "items" not in cleaned
    assert cleaned["type"] == "array"


def test_empty_properties_dropped_only_when_paired_with_empty_anyof() -> None:
    """Empty ``properties`` is legitimate on a root object schema; only
    drop it when the same node also carries the bug-marker empty
    anyOf — that's the mcpadapt-emitted shape we're cleaning."""
    # Drop case: empty anyOf + empty properties on the same node.
    bug_shape = {
        "anyOf": [],
        "properties": {},
        "type": "string",
    }
    cleaned_bug = _clean_schema_dict(bug_shape)
    assert "anyOf" not in cleaned_bug
    assert "properties" not in cleaned_bug

    # Preserve case: empty properties without empty anyOf is a
    # legitimate "this object accepts no properties" schema.
    legit = {
        "type": "object",
        "properties": {},
    }
    cleaned_legit = _clean_schema_dict(legit)
    assert cleaned_legit["properties"] == {}


def test_clean_schema_recurses_into_nested_properties() -> None:
    schema = {
        "type": "object",
        "properties": {
            "outer": {
                "type": "object",
                "properties": {
                    "inner": {"anyOf": [], "type": "string"},
                },
            },
        },
    }
    cleaned = _clean_schema_dict(schema)
    assert "anyOf" not in cleaned["properties"]["outer"]["properties"]["inner"]
    assert (
        cleaned["properties"]["outer"]["properties"]["inner"]["type"] == "string"
    )


def test_empty_anyof_with_int_default_infers_integer_type() -> None:
    """Empty ``anyOf`` was the property's only type carrier;
    infer from the default once the bad anyOf is dropped."""
    schema = {
        "anyOf": [],
        "default": 25,
        "title": "Delay Ms",
    }
    cleaned = _clean_schema_dict(schema)
    assert "anyOf" not in cleaned
    assert cleaned["type"] == "integer"
    assert cleaned["default"] == 25


def test_empty_anyof_with_str_default_infers_string_type() -> None:
    schema = {"anyOf": [], "default": "fallback"}
    cleaned = _clean_schema_dict(schema)
    assert cleaned["type"] == "string"


def test_empty_anyof_with_bool_default_infers_boolean_type() -> None:
    """Boolean check must precede int because ``isinstance(True, int)``
    is True in Python — without the boolean-first guard a True default
    would mis-infer as integer."""
    schema = {"anyOf": [], "default": True}
    cleaned = _clean_schema_dict(schema)
    assert cleaned["type"] == "boolean"


def test_empty_anyof_with_no_default_falls_back_to_string() -> None:
    """Most-permissive primitive that still satisfies OpenAI strict
    mode. mcpadapt-emitted required properties with empty anyOf hit
    this path."""
    schema = {"anyOf": [], "title": "Some Param"}
    cleaned = _clean_schema_dict(schema)
    assert cleaned["type"] == "string"


def test_existing_type_is_not_overwritten_by_inference() -> None:
    """When the property already carries an explicit ``type`` AND an
    empty anyOf (mcpadapt sometimes emits both), the explicit type
    wins — we never clobber a legitimate type with a guessed one."""
    schema = {"anyOf": [], "type": "string", "default": 42}
    cleaned = _clean_schema_dict(schema)
    assert cleaned["type"] == "string"  # not "integer"


def test_clean_schema_recurses_into_anyof_oneof_allof_lists() -> None:
    """Nested types inside non-empty anyOf are walked too — mcpadapt
    emits the bug pattern at depth as well as on root properties."""
    schema = {
        "anyOf": [
            {"type": "string", "enum": None},
            {"anyOf": [], "type": "integer"},
        ],
    }
    cleaned = _clean_schema_dict(schema)
    assert "enum" not in cleaned["anyOf"][0]
    assert "anyOf" not in cleaned["anyOf"][1]


# ---------------------------------------------------------------------
# Public ``crewai_mcp_schema_fixup`` integration shape
# ---------------------------------------------------------------------


def _make_pydantic_class_with_bug(name: str) -> type[BaseModel]:
    """Build a Pydantic class whose ``model_json_schema`` returns
    a schema with the mcpadapt bug shape (empty anyOf on a property)."""

    class _Schema(BaseModel):
        text: str

    # Override model_json_schema to emit the broken shape mcpadapt
    # produces. Real mcpadapt-bridged classes look identical when
    # serialised — we just inject the same shape directly to keep
    # the test mcp-free.
    def _broken(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "text": {
                    "anyOf": [],
                    "description": "",
                    "enum": None,
                    "items": None,
                    "title": "Text",
                    "type": "string",
                },
            },
            "required": ["text"],
            "title": f"{name}Arguments",
        }

    _Schema.model_json_schema = _broken  # type: ignore[method-assign,assignment]
    _Schema.__name__ = f"{name}Arguments"
    return _Schema


def _make_agent(*tool_schemas: type[BaseModel]) -> SimpleNamespace:
    """Construct a minimal agent-shaped object with .tools[].args_schema."""
    tools = [SimpleNamespace(args_schema=cls) for cls in tool_schemas]
    return SimpleNamespace(tools=tools)


def test_fixup_cleans_schema_in_place_on_a_single_tool_agent() -> None:
    schema_cls = _make_pydantic_class_with_bug("echo")
    agent = _make_agent(schema_cls)

    # Pre-fixup the schema is the broken shape.
    raw = agent.tools[0].args_schema.model_json_schema()
    assert raw["properties"]["text"].get("anyOf") == []
    assert raw["properties"]["text"].get("enum") is None
    assert raw["properties"]["text"].get("items") is None

    crewai_mcp_schema_fixup(agent)

    cleaned = agent.tools[0].args_schema.model_json_schema()
    assert "anyOf" not in cleaned["properties"]["text"]
    assert "enum" not in cleaned["properties"]["text"]
    assert "items" not in cleaned["properties"]["text"]
    assert cleaned["properties"]["text"]["type"] == "string"


def test_fixup_is_idempotent_on_repeated_calls() -> None:
    schema_cls = _make_pydantic_class_with_bug("echo")
    agent = _make_agent(schema_cls)

    crewai_mcp_schema_fixup(agent)
    first_pass = agent.tools[0].args_schema.model_json_schema()

    crewai_mcp_schema_fixup(agent)
    second_pass = agent.tools[0].args_schema.model_json_schema()

    assert first_pass == second_pass


def test_fixup_cleans_each_tool_independently_on_multi_tool_agent() -> None:
    echo_cls = _make_pydantic_class_with_bug("echo")
    add_cls = _make_pydantic_class_with_bug("add")
    agent = _make_agent(echo_cls, add_cls)

    crewai_mcp_schema_fixup(agent)

    for tool in agent.tools:
        cleaned = tool.args_schema.model_json_schema()
        assert "anyOf" not in cleaned["properties"]["text"]
        assert "enum" not in cleaned["properties"]["text"]


def test_fixup_handles_agent_with_no_tools() -> None:
    """An agent with an empty tools list must not raise — operators
    may share a helper-call site across agents whose tools vary."""
    agent = _make_agent()
    crewai_mcp_schema_fixup(agent)  # no exception
    assert agent.tools == []


def test_fixup_skips_tools_with_no_args_schema() -> None:
    """Some CrewAI tools (free-form text agents) have no
    ``args_schema``. The fixup must skip those rather than crash."""
    agent = SimpleNamespace(
        tools=[
            SimpleNamespace(args_schema=None),
            SimpleNamespace(args_schema=_make_pydantic_class_with_bug("echo")),
        ],
    )

    crewai_mcp_schema_fixup(agent)

    cleaned = agent.tools[1].args_schema.model_json_schema()
    assert "anyOf" not in cleaned["properties"]["text"]


def test_fixup_raises_importerror_when_crewai_not_installed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The compat module imports cleanly without crewai installed,
    but calling the function without crewai must raise ImportError
    with an actionable install instruction.

    Simulated by stashing ``sys.modules['crewai']`` to None so the
    inline ``import crewai`` inside the function fails as if the
    package were missing."""
    import sys

    monkeypatch.setitem(sys.modules, "crewai", None)
    agent = _make_agent(_make_pydantic_class_with_bug("echo"))

    with pytest.raises(ImportError) as exc_info:
        crewai_mcp_schema_fixup(agent)

    assert "pip install crewai" in str(exc_info.value)
