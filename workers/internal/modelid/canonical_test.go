package modelid

import "testing"

// Test vectors for Canonicalize: the spellings model ids reach
// Flightdeck in, from provider APIs, cloud platforms, gateways and local
// servers.
func TestCanonicalize(t *testing.T) {
	cases := []struct {
		raw, model, scope string
	}{
		// Provider API ids, dated snapshots kept.
		{"claude-sonnet-4-5", "claude-sonnet-4-5", ""},
		{"claude-sonnet-4-5-20250929", "claude-sonnet-4-5-20250929", ""},
		{"gpt-5.1-2025-11-13", "gpt-5.1-2025-11-13", ""},
		{"gpt-4o-mini", "gpt-4o-mini", ""},
		{"  Claude-Opus-4-6 ", "claude-opus-4-6", ""},
		// Vertex AI version suffix.
		{"claude-sonnet-4-5@20250929", "claude-sonnet-4-5", ""},
		{"gemini-2.5-pro@001", "gemini-2.5-pro", ""},
		// Bedrock ids and inference profiles.
		{"anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5-20250929", ""},
		{"us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5-20250929", ScopeRegional},
		{"eu.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5-20251001", ScopeRegional},
		{"apac.anthropic.claude-3-5-sonnet-20241022-v2:0", "claude-3-5-sonnet-20241022", ScopeRegional},
		{"global.anthropic.claude-opus-4-6-v1", "claude-opus-4-6", ScopeGlobal},
		{"amazon.titan-embed-text-v2:0", "amazon.titan-embed-text-v2:0", ""},
		{"us.meta.llama3-3-70b-instruct-v1:0", "meta.llama3-3-70b-instruct-v1:0", ScopeRegional},
		// Gateway and platform prefixes.
		{"openrouter/anthropic/claude-sonnet-4.5", "claude-sonnet-4-5", ""},
		{"anthropic/claude-sonnet-4-5", "claude-sonnet-4-5", ""},
		{"bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5-20250929", ScopeRegional},
		{"vertex_ai/claude-sonnet-4-5@20250929", "claude-sonnet-4-5", ""},
		{"openai/gpt-4o", "gpt-4o", ""},
		{"meta-llama/llama-3.1-70b-instruct", "llama-3.1-70b-instruct", ""},
		// OpenRouter route suffixes dropped; other colon tags kept.
		{"openrouter/meta-llama/llama-3.3-70b-instruct:free", "llama-3.3-70b-instruct", ""},
		{"deepseek/deepseek-r1:nitro", "deepseek-r1", ""},
		{"llama3.1:8b", "llama3.1:8b", ""},
		{"ollama/qwen2.5-coder:32b", "qwen2.5-coder:32b", ""},
		// Dotted Claude versions become hyphenated; other models' dots stay.
		{"claude-3.5-sonnet", "claude-3-5-sonnet", ""},
		{"claude-opus-4.1", "claude-opus-4-1", ""},
		{"gemini-2.5-flash", "gemini-2.5-flash", ""},
		// OpenAI fine-tunes keep "ft:" and the canonical base model.
		{"ft:gpt-4o-mini-2024-07-18:acme::AbC123", "ft:gpt-4o-mini-2024-07-18", ""},
		{"ft:gpt-4.1:acme:support-bot:XyZ9", "ft:gpt-4.1", ""},
		{"ft:", "ft:", ""},
		// Hugging Face Hub models keep their organisation.
		{"hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M", "bartowski/llama-3.2-3b-instruct-gguf:q4_k_m", ""},
		{"huggingface.co/Qwen/Qwen2.5-7B", "qwen/qwen2.5-7b", ""},
		// Unrecognised ids pass through lower-cased; empty stays empty.
		{"My-Azure-Deployment", "my-azure-deployment", ""},
		{"", "", ""},
		{"   ", "", ""},
		// A trailing slash is not a path segment.
		{"weird/", "weird/", ""},
	}
	for _, tc := range cases {
		got := Canonicalize(tc.raw)
		if got.Model != tc.model || got.InferenceScope != tc.scope {
			t.Errorf("Canonicalize(%q) = {%q, %q}, want {%q, %q}",
				tc.raw, got.Model, got.InferenceScope, tc.model, tc.scope)
		}
	}
}

func TestCanonicalize_IsIdempotent(t *testing.T) {
	for _, raw := range []string{
		"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
		"openrouter/anthropic/claude-sonnet-4.5:beta",
		"claude-sonnet-4-5@20250929",
		"llama3.1:8b",
		"amazon.titan-embed-text-v2:0",
		"ft:gpt-4o-mini-2024-07-18:acme::AbC123",
		"hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M",
	} {
		once := Canonicalize(raw).Model
		if twice := Canonicalize(once).Model; twice != once {
			t.Errorf("Canonicalize not idempotent for %q: %q then %q", raw, once, twice)
		}
	}
}

func TestProvider(t *testing.T) {
	cases := map[string]string{
		"claude-sonnet-4-5":               "anthropic",
		"claude-3-5-haiku-20241022":       "anthropic",
		"gpt-5.1":                         "openai",
		"chatgpt-4o-latest":               "openai",
		"o1":                              "openai",
		"o3":                              "openai",
		"o3-mini":                         "openai",
		"o4-mini-2025-04-16":              "openai",
		"ft:gpt-4o-mini-2024-07-18":       "openai",
		"text-embedding-3-small":          "openai",
		"gpt-image-1":                     "openai",
		"omni-moderation-latest":          "openai",
		"gemini-2.5-pro":                  "google",
		"gemma-3-27b-it":                  "google",
		"grok-4":                          "xai",
		"mistral-large-latest":            "mistral",
		"codestral-2501":                  "mistral",
		"devstral-medium":                 "mistral",
		"llama-3.1-70b-instruct":          "meta",
		"llama3.1:8b":                     "meta",
		"deepseek-r1":                     "deepseek",
		"deepseek-chat":                   "deepseek",
		"qwen2.5-coder:32b":               "other",
		"o":                               "other",
		"orca-mini":                       "other",
		"meta.llama3-3-70b-instruct-v1:0": "meta",
		"amazon.titan-embed-text-v2:0":    "other",
		"mistral.mistral-large-2407-v1:0": "mistral",
		"":                                "other",
	}
	for model, want := range cases {
		if got := Provider(model); got != want {
			t.Errorf("Provider(%q) = %q, want %q", model, got, want)
		}
	}
}
