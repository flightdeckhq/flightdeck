// Package modelid turns the many spellings of an LLM model id into one
// canonical id, and derives the model's vendor from it. Both are pure
// string rules with no lookup, so the worker applies them identically
// on the write path and in the backfill, and a table of test vectors
// pins them.
package modelid

import (
	"regexp"
	"strings"
)

// Inference scopes a Bedrock inference-profile prefix implies.
const (
	ScopeGlobal   = "global"
	ScopeRegional = "regional"
)

// Canonical is a canonicalised model id and, when the raw id was a
// Bedrock inference profile, the endpoint scope its region prefix named.
type Canonical struct {
	Model          string
	InferenceScope string
}

// bedrockProfile matches a Bedrock inference profile: a region prefix
// in front of a vendor-qualified Bedrock model id.
var bedrockProfile = regexp.MustCompile(
	`^(us|eu|apac|global|us-gov|jp|au|ca)\.` +
		`((?:anthropic|meta|amazon|mistral|cohere|ai21|deepseek|openai|qwen|writer)\..+)$`,
)

// bedrockClaude matches a Claude model id in Bedrock's form, with the
// "anthropic." vendor prefix and the Bedrock version suffix
// ("anthropic.claude-sonnet-4-5-20250929-v1:0"). Other vendors' Bedrock
// ids are left whole: their "-v2:0"-style suffix is often part of the
// model's name ("amazon.titan-embed-text-v2:0"), and the catalogue keys
// them in Bedrock's form.
var bedrockClaude = regexp.MustCompile(`^anthropic\.(claude.+?)(?:-v\d+(?::\d+)?)?$`)

// openRouterVariants are the routing suffixes OpenRouter appends after a
// colon; they select a route, not a different model. A colon suffix
// that is not one of these (an Ollama tag such as "llama3.1:8b") names a
// different model and is kept.
var openRouterVariants = map[string]bool{
	"free": true, "beta": true, "nitro": true, "floor": true,
	"online": true, "extended": true, "thinking": true,
}

// claudeDottedVersion matches a dot between two digits, the form
// gateways use for Claude versions ("claude-sonnet-4.5") where the API
// uses a hyphen ("claude-sonnet-4-5").
var claudeDottedVersion = regexp.MustCompile(`(\d)\.(\d)`)

// Canonicalize returns the canonical form of a raw model id. An id the
// rules do not recognise is returned lower-cased and trimmed.
func Canonicalize(raw string) Canonical {
	id := strings.ToLower(strings.TrimSpace(raw))
	if id == "" {
		return Canonical{}
	}
	// Gateway and platform prefixes ("openrouter/anthropic/...",
	// "bedrock/...", "vertex_ai/...", "meta-llama/..."): the model is
	// the last path segment.
	if i := strings.LastIndex(id, "/"); i >= 0 && i < len(id)-1 {
		id = id[i+1:]
	}

	var scope string
	if m := bedrockProfile.FindStringSubmatch(id); m != nil {
		scope = ScopeRegional
		if m[1] == "global" {
			scope = ScopeGlobal
		}
		id = m[2]
	}
	if m := bedrockClaude.FindStringSubmatch(id); m != nil {
		id = m[1]
	}

	// Vertex AI names a version after "@" ("claude-sonnet-4-5@20250929").
	if i := strings.IndexByte(id, '@'); i > 0 {
		id = id[:i]
	}
	if i := strings.LastIndexByte(id, ':'); i > 0 && openRouterVariants[id[i+1:]] {
		id = id[:i]
	}
	if strings.HasPrefix(id, "claude") {
		id = claudeDottedVersion.ReplaceAllString(id, "$1-$2")
	}
	return Canonical{Model: id, InferenceScope: scope}
}

// openAIModel matches OpenAI's model families: GPT, the o-series
// reasoning models ("o1", "o3-mini", "o4-mini"), ChatGPT, Codex and the
// embedding, image and speech models.
var openAIModel = regexp.MustCompile(
	`^(gpt-|chatgpt-|o[1-9](-|$)|codex-|text-embedding-|dall-e-|gpt-image-|whisper-|tts-|omni-moderation)`,
)

// Provider derives the model's vendor from a canonical model id:
// anthropic, openai, google, xai, mistral, meta, deepseek or other.
func Provider(canonical string) string {
	// A Bedrock id that keeps its vendor prefix ("meta.llama3-...")
	// names the vendor directly.
	if vendor, _, ok := strings.Cut(canonical, "."); ok {
		if p, known := bedrockVendors[vendor]; known {
			return p
		}
	}
	switch {
	case strings.HasPrefix(canonical, "claude"):
		return "anthropic"
	case openAIModel.MatchString(canonical):
		return "openai"
	case strings.HasPrefix(canonical, "gemini") || strings.HasPrefix(canonical, "gemma"):
		return "google"
	case strings.HasPrefix(canonical, "grok"):
		return "xai"
	case hasAnyPrefix(canonical, "mistral", "mixtral", "codestral", "ministral",
		"pixtral", "magistral", "devstral", "open-mistral", "open-mixtral"):
		return "mistral"
	case strings.HasPrefix(canonical, "llama"):
		return "meta"
	case strings.HasPrefix(canonical, "deepseek"):
		return "deepseek"
	default:
		return "other"
	}
}

// bedrockVendors maps the vendor prefix of a Bedrock model id to the
// provider; vendors outside the provider vocabulary map to "other".
var bedrockVendors = map[string]string{
	"anthropic": "anthropic",
	"meta":      "meta",
	"mistral":   "mistral",
	"deepseek":  "deepseek",
	"openai":    "openai",
	"amazon":    "other",
	"cohere":    "other",
	"ai21":      "other",
	"qwen":      "other",
	"writer":    "other",
}

func hasAnyPrefix(s string, prefixes ...string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}
