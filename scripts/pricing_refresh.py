#!/usr/bin/env python3
"""Regenerate the pricing catalogue the API embeds.

Flightdeck prices LLM calls from a pruned copy of litellm's
``model_prices_and_context_window.json`` (ARCHITECTURE.md, Cost
estimation > Pricing table). This script downloads the current file
(or reads a local copy), keeps the models and fields the cost model
uses, and writes ``api/internal/store/pricing_catalogue.json``:

    python3 scripts/pricing_refresh.py               # download from litellm main
    python3 scripts/pricing_refresh.py --source path/to/file.json

``make pricing-refresh`` runs it. The result ships as an ordinary pull
request; the API itself never fetches prices.

Kept: chat, responses and embedding models served by the providers the
cost model knows (Anthropic, OpenAI, Google, xAI, Mistral, DeepSeek,
Meta) on their own APIs, Amazon Bedrock, Google Vertex AI, Azure OpenAI
and Microsoft Foundry. Every other provider, mode and field is dropped,
which also keeps the embedded file small.
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "api" / "internal" / "store" / "pricing_catalogue.json"
SOURCE_URL = (
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
)
# A download of a few megabytes; generous enough for a slow link, short
# enough that a hung connection fails the refresh instead of stalling it.
DOWNLOAD_TIMEOUT_S = 60

MODES = {"chat", "responses", "embedding"}

# litellm provider names kept, as exact names or prefixes (the Vertex AI
# entries are split across vertex_ai-* families).
PROVIDERS = {
    "anthropic",
    "openai",
    "azure",
    "azure_ai",
    "bedrock",
    "bedrock_converse",
    "gemini",
    "xai",
    "mistral",
    "deepseek",
    "meta_llama",
}
PROVIDER_PREFIXES = ("vertex_ai",)

# Fields the API reads: base rates, cache rates, the one-hour cache write,
# reasoning, priority, context tiers, the per-model fast-mode multiplier
# and the deprecation date.
FIELDS = {
    "litellm_provider",
    "mode",
    "deprecation_date",
    "input_cost_per_token",
    "output_cost_per_token",
    "cache_read_input_token_cost",
    "cache_creation_input_token_cost",
    "cache_creation_input_token_cost_above_1hr",
    "output_cost_per_reasoning_token",
    "input_cost_per_token_priority",
    "provider_specific_entry",
}
TIER_FIELD = re.compile(
    r"^(input_cost_per_token|output_cost_per_token|cache_read_input_token_cost"
    r"|cache_creation_input_token_cost|cache_creation_input_token_cost_above_1hr)"
    r"_above_\d+k_tokens$"
)


def kept_provider(provider: Any) -> bool:
    if not isinstance(provider, str):
        return False
    return provider in PROVIDERS or provider.startswith(PROVIDER_PREFIXES)


def prune(catalogue: dict[str, Any]) -> dict[str, Any]:
    """The catalogue entries and fields the cost model uses."""
    out: dict[str, Any] = {}
    for model_id, entry in catalogue.items():
        if not isinstance(entry, dict):
            continue  # litellm's "sample_spec" documentation entry
        if entry.get("mode") not in MODES or not kept_provider(entry.get("litellm_provider")):
            continue
        if not isinstance(entry.get("input_cost_per_token"), int | float):
            continue
        kept = {k: v for k, v in entry.items() if k in FIELDS or TIER_FIELD.match(k)}
        specific = kept.get("provider_specific_entry")
        if isinstance(specific, dict):
            fast = specific.get("fast")
            if isinstance(fast, int | float):
                kept["provider_specific_entry"] = {"fast": fast}
            else:
                kept.pop("provider_specific_entry")
        else:
            kept.pop("provider_specific_entry", None)
        out[model_id] = kept
    return dict(sorted(out.items()))


def load(source: str | None) -> dict[str, Any]:
    if source:
        return json.loads(Path(source).read_text(encoding="utf-8"))
    with urllib.request.urlopen(SOURCE_URL, timeout=DOWNLOAD_TIMEOUT_S) as resp:
        return json.loads(resp.read())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--source", help="read this local JSON file instead of downloading")
    parser.add_argument("--output", default=str(OUTPUT), help="where to write the catalogue")
    args = parser.parse_args(argv)

    models = prune(load(args.source))
    if not models:
        print("pricing_refresh: no models kept; refusing to write an empty catalogue")
        return 1
    document = {
        "source": args.source or SOURCE_URL,
        "refreshed": datetime.date.today().isoformat(),
        "models": models,
    }
    Path(args.output).write_text(json.dumps(document, indent=1) + "\n", encoding="utf-8")
    print(f"pricing_refresh: wrote {len(models)} models to {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
