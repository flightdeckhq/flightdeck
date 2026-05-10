"""CrewAI + mcpadapt schema fixup compat helper.

Workaround for an upstream mcpadapt schema-generation bug. mcpadapt's
``CrewAIAdapter`` builds a Pydantic ``args_schema`` from each MCP
tool's ``inputSchema`` via ``create_model_from_json_schema``. When
CrewAI later serialises that ``args_schema`` back to JSON Schema (via
``generate_model_description`` and ``model_json_schema()``), the
serialisation emits keys that violate JSON Schema draft 2020-12:

  - ``anyOf: []`` (empty array — 2020-12 requires at least one item)
  - ``enum: null`` (2020-12 requires an array)
  - ``items: null`` (only valid as an array of schemas or a single schema)
  - ``properties: {}`` paired with the empty ``anyOf`` above

Both OpenAI and Anthropic reject the resulting schema:

  - OpenAI surfaces it as ``"tools[0].function.parameters": None
    is not of type 'object', 'boolean'"`` (strict-mode validation
    coalesces the malformed schema into ``None``).
  - Anthropic returns ``"tools.0.custom.input_schema: JSON schema is
    invalid. It must match JSON Schema draft 2020-12"``.

Operators using CrewAI + MCP today need to call
:func:`crewai_mcp_schema_fixup` on their agent after constructing it
to strip the offending keys. The helper is idempotent and safe to
call multiple times; it patches each tool's ``args_schema`` Pydantic
class so every downstream consumer (CrewAI's
``generate_model_description``, the LLM provider's tool-conversion
path, raw ``model_json_schema()`` calls) sees the cleaned schema.

Remove this module once mcpadapt emits valid schemas. See README
"Known framework constraints" for the operator-facing explanation
and the README Roadmap for the removal checkbox.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    import crewai


_FIXED_FLAG = "_flightdeck_compat_schema_fixed"
_CLEANED_ATTR = "_flightdeck_compat_cleaned_schema"


def crewai_mcp_schema_fixup(agent: crewai.Agent) -> None:
    """Strip JSON-Schema-2020-12-invalid keys from each tool's
    ``args_schema`` serialisation output so OpenAI / Anthropic APIs
    accept the schema.

    Cleans:
      - ``anyOf: []`` (empty array)
      - ``enum: None`` (null)
      - ``items: None`` (null)
      - ``properties: {}`` (empty dict, only when paired with
        empty ``anyOf`` on the same property — preserves legitimate
        empty-properties usage on root schemas)

    Mutates the agent's tools in-place by patching each tool's
    ``args_schema`` Pydantic class so the cleaned schema is what
    every downstream caller (CrewAI's ``generate_model_description``,
    the OpenAI / Anthropic provider tool-conversion paths, raw
    ``model_json_schema()`` calls) sees.

    Idempotent — calling the function twice on the same agent has
    no effect on the second call. Each patched class is tagged
    with a sentinel attribute so subsequent calls short-circuit.

    Raises:
      ImportError: if ``crewai`` is not installed in the venv.

    Example::

        import crewai
        from mcpadapt.core import MCPAdapt
        from mcpadapt.crewai_adapter import CrewAIAdapter
        from flightdeck_sensor.compat.crewai_mcp import (
            crewai_mcp_schema_fixup,
        )

        with MCPAdapt(server_params, CrewAIAdapter()) as tools:
            agent = crewai.Agent(role=..., goal=..., tools=tools)
            crewai_mcp_schema_fixup(agent)
            # agent now ready to invoke; LLM tool-call payload uses
            # cleaned JSON Schema.
    """
    try:
        import crewai  # noqa: F401  -- presence check
    except ImportError as exc:  # pragma: no cover - covered by unit test
        raise ImportError(
            "crewai_mcp_schema_fixup requires crewai. Install with: pip install crewai mcpadapt"
        ) from exc

    tools = getattr(agent, "tools", None) or []
    for tool in tools:
        args_schema = getattr(tool, "args_schema", None)
        if args_schema is None:
            continue
        _patch_args_schema(args_schema)


def _patch_args_schema(args_schema_cls: Any) -> None:
    """Replace ``model_json_schema`` on the args_schema class with a
    closure that returns the cleaned schema, regardless of args /
    kwargs the caller passes.

    The replacement ignores the ``mode`` / ``ref_template`` kwargs
    Pydantic accepts because:

      1. CrewAI's ``generate_model_description`` and the LLM
         provider tool-conversion paths only call
         ``model_json_schema()`` with no args.
      2. The single cached cleaned schema is what BOTH validation-
         mode and serialisation-mode callers expect for a tool
         input schema (the modes only differ for fields with
         model-level validators / aliases, which mcpadapt-bridged
         tool schemas don't carry).
    """
    if getattr(args_schema_cls, _FIXED_FLAG, False):
        return  # idempotent

    raw_schema = args_schema_cls.model_json_schema()
    cleaned = _clean_schema_dict(raw_schema)

    setattr(args_schema_cls, _CLEANED_ATTR, cleaned)
    setattr(args_schema_cls, _FIXED_FLAG, True)

    def _cleaned_model_json_schema(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        result: dict[str, Any] = getattr(args_schema_cls, _CLEANED_ATTR)
        return result

    # Replace at the class level. Setting a plain function as a class
    # attribute means ``Cls.model_json_schema()`` and
    # ``instance.model_json_schema()`` both bypass the original
    # classmethod and call our closure with the class / instance as
    # the first positional arg, which we ignore via ``*_args``.
    args_schema_cls.model_json_schema = _cleaned_model_json_schema


def _clean_schema_dict(schema: Any) -> Any:
    """Recursively strip JSON-Schema-2020-12-invalid keys from a
    schema dict.

    The cleaning is shallow-recursive: each property value is
    cleaned in turn, but list-of-schemas (``anyOf``, ``oneOf``,
    ``allOf``) elements are also walked because mcpadapt's nested
    types can show the same invalid-empty-anyOf pattern at any
    depth.

    Non-dict / non-list values pass through unchanged. ``None``
    values for ``enum`` / ``items`` are dropped via the per-key
    check rather than via a generic null-strip so legitimate
    null-typed fields (e.g. ``"type": null`` is a valid schema)
    aren't lost.

    Type inference: removing the bug-marker empty ``anyOf`` can
    leave a property with no ``type``, which OpenAI's strict-mode
    validator also rejects. When the property carries a ``default``
    value, infer ``type`` from the Python type of the default
    (``int`` → ``"integer"``, ``float`` → ``"number"``,
    ``bool`` → ``"boolean"``, ``str`` → ``"string"``, ``list`` →
    ``"array"``, ``dict`` → ``"object"``). Properties with neither
    ``type`` nor ``default`` fall through to ``"string"`` — the
    most permissive primitive that still satisfies strict-mode
    validation. The inference only triggers when the original
    property carried the empty-``anyOf`` bug marker; well-formed
    schemas pass through unchanged.
    """
    if isinstance(schema, list):
        return [
            _clean_schema_dict(item) if isinstance(item, (dict, list)) else item for item in schema
        ]
    if not isinstance(schema, dict):
        return schema

    has_empty_anyof = schema.get("anyOf") == []
    cleaned: dict[str, Any] = {}
    for key, value in schema.items():
        if key == "anyOf" and value == []:
            continue
        if key == "enum" and value is None:
            continue
        if key == "items" and value is None:
            continue
        if key == "properties" and value == {} and has_empty_anyof:
            continue
        if isinstance(value, (dict, list)):
            cleaned[key] = _clean_schema_dict(value)
        else:
            cleaned[key] = value

    # If we just stripped a bug-marker empty anyOf and the surviving
    # schema has no ``type``, infer one. OpenAI strict-mode rejects
    # type-less property schemas; the empty anyOf was the previous
    # type carrier so we restore one.
    if has_empty_anyof and "type" not in cleaned:
        cleaned["type"] = _infer_type_from_default(cleaned.get("default"))

    return cleaned


def _infer_type_from_default(default: Any) -> str:
    """Map a Python default value to its JSON Schema primitive type."""
    if isinstance(default, bool):
        return "boolean"
    if isinstance(default, int):
        return "integer"
    if isinstance(default, float):
        return "number"
    if isinstance(default, list):
        return "array"
    if isinstance(default, dict):
        return "object"
    if isinstance(default, str):
        return "string"
    # No default OR default is None: most tool parameters are strings,
    # which is the most permissive primitive that still satisfies
    # strict-mode validation. Caller can override post-fixup if a
    # specific case needs a different fallback.
    return "string"
