"""Tests for scripts/pricing_refresh.py.

python3 -m unittest scripts/test_pricing_refresh.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import pricing_refresh

SAMPLE = {
    "sample_spec": {"litellm_provider": "doc", "mode": "chat"},
    "claude-sonnet-4-5": {
        "litellm_provider": "anthropic",
        "mode": "chat",
        "input_cost_per_token": 3e-06,
        "output_cost_per_token": 1.5e-05,
        "cache_creation_input_token_cost_above_1hr": 6e-06,
        "input_cost_per_token_above_200k_tokens": 6e-06,
        "max_tokens": 64000,
        "supports_vision": True,
        "provider_specific_entry": {"us": 1.1, "fast": 2},
    },
    "vertex_ai/claude-sonnet-4-5@20250929": {
        "litellm_provider": "vertex_ai-anthropic_models",
        "mode": "chat",
        "input_cost_per_token": 3e-06,
        "output_cost_per_token": 1.5e-05,
    },
    "dall-e-3": {"litellm_provider": "openai", "mode": "image_generation", "input_cost_per_token": 0},
    "together_ai/llama": {
        "litellm_provider": "together_ai",
        "mode": "chat",
        "input_cost_per_token": 1e-07,
    },
    "no-rate": {"litellm_provider": "openai", "mode": "chat"},
}


class PruneTest(unittest.TestCase):
    def test_keeps_supported_providers_and_modes_only(self) -> None:
        pruned = pricing_refresh.prune(SAMPLE)
        self.assertEqual(
            sorted(pruned), ["claude-sonnet-4-5", "vertex_ai/claude-sonnet-4-5@20250929"]
        )

    def test_keeps_only_the_fields_the_cost_model_reads(self) -> None:
        entry = pricing_refresh.prune(SAMPLE)["claude-sonnet-4-5"]
        self.assertNotIn("max_tokens", entry)
        self.assertNotIn("supports_vision", entry)
        self.assertEqual(entry["input_cost_per_token_above_200k_tokens"], 6e-06)
        self.assertEqual(entry["cache_creation_input_token_cost_above_1hr"], 6e-06)
        self.assertEqual(entry["provider_specific_entry"], {"fast": 2})

    def test_main_writes_the_catalogue_and_refuses_an_empty_one(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "source.json"
            output = Path(tmp) / "catalogue.json"
            source.write_text(json.dumps(SAMPLE))
            self.assertEqual(
                pricing_refresh.main(["--source", str(source), "--output", str(output)]), 0
            )
            document = json.loads(output.read_text())
            self.assertEqual(len(document["models"]), 2)
            self.assertIn("refreshed", document)

            source.write_text(json.dumps({"dall-e-3": SAMPLE["dall-e-3"]}))
            self.assertEqual(
                pricing_refresh.main(["--source", str(source), "--output", str(output)]), 1
            )


if __name__ == "__main__":
    unittest.main()
