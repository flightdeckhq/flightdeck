package handlers

import (
	"fmt"
	"math"
)

// Vocabularies of the token and cost fields an LLM event may carry. The
// worker stores billing_mode, provider and cost_source in events
// columns that analytics group by, so an unknown value is rejected here
// rather than becoming a bucket of its own.
var (
	validBillingModes = map[string]bool{
		"metered":      true,
		"subscription": true,
		"local":        true,
	}
	validProviders = map[string]bool{
		"anthropic": true,
		"openai":    true,
		"google":    true,
		"xai":       true,
		"mistral":   true,
		"meta":      true,
		"deepseek":  true,
		"other":     true,
	}
	validCostSources = map[string]bool{
		"provider": true,
		"agent":    true,
	}
	validInferenceScopes = map[string]bool{
		"global":   true,
		"regional": true,
	}
)

// maxTokenCostStringLen bounds the free-form strings a provider reports
// about a call (model ids, service tier, speed, data residency, stop
// reason). Real values are a few dozen characters; 256 matches the cap
// on the other identity strings an event carries.
const maxTokenCostStringLen = 256

// maxPlatformLen bounds provider_metadata.platform, which is either a
// fixed label or a hostname: 253 characters is the DNS limit on a fully
// qualified name, the bound the sensor applies before sending it.
const maxPlatformLen = 253

// validateTokenCostFields checks the token, model and cost fields of the
// event payload contract (ARCHITECTURE.md, POST /v1/events). Every field
// is optional and a JSON null counts as absent, so events from clients
// that send none of them are unaffected. It returns an error message, or
// "" when the payload is valid.
func validateTokenCostFields(payload map[string]any) string {
	for _, key := range []string{"tokens_reasoning", "tokens_cache_creation_1h"} {
		if msg := checkCount(payload, key); msg != "" {
			return msg
		}
	}
	if msg := checkSubset(payload, "tokens_reasoning", "tokens_output"); msg != "" {
		return msg
	}
	if msg := checkSubset(payload, "tokens_cache_creation_1h", "tokens_cache_creation"); msg != "" {
		return msg
	}

	cost, hasCost := present(payload, "cost_reported")
	source, hasSource := present(payload, "cost_source")
	if hasCost != hasSource {
		return "cost_reported and cost_source must be sent together"
	}
	if hasCost {
		n, ok := cost.(float64)
		if !ok || n < 0 || math.IsInf(n, 0) || math.IsNaN(n) {
			return "cost_reported must be a non-negative number"
		}
		if msg := checkEnum("cost_source", source, validCostSources); msg != "" {
			return msg
		}
	}

	enums := []struct {
		key   string
		valid map[string]bool
	}{
		{"billing_mode", validBillingModes},
		{"provider", validProviders},
		{"inference_scope", validInferenceScopes},
	}
	for _, e := range enums {
		if v, ok := present(payload, e.key); ok {
			if msg := checkEnum(e.key, v, e.valid); msg != "" {
				return msg
			}
		}
	}

	for _, key := range []string{
		"model_requested", "model_served", "service_tier", "speed",
		"inference_geo", "stop_reason",
	} {
		if v, ok := present(payload, key); ok {
			if msg := checkString(key, v, maxTokenCostStringLen); msg != "" {
				return msg
			}
		}
	}

	if v, ok := present(payload, "server_tool_use"); ok {
		counters, isObj := v.(map[string]any)
		if !isObj {
			return "server_tool_use must be an object"
		}
		for name, count := range counters {
			if n, isNum := count.(float64); !isNum || n < 0 || n != math.Trunc(n) {
				return fmt.Sprintf("server_tool_use.%s must be a non-negative integer", name)
			}
		}
	}

	if meta, ok := payload["provider_metadata"].(map[string]any); ok {
		if v, ok := present(meta, "platform"); ok {
			if msg := checkString("provider_metadata.platform", v, maxPlatformLen); msg != "" {
				return msg
			}
		}
	}
	return ""
}

// present returns the value under key and whether it is set to
// something other than JSON null.
func present(payload map[string]any, key string) (any, bool) {
	v, ok := payload[key]
	return v, ok && v != nil
}

// checkCount rejects a token count that is not a non-negative integer.
func checkCount(payload map[string]any, key string) string {
	v, ok := present(payload, key)
	if !ok {
		return ""
	}
	if n, isNum := v.(float64); !isNum || n < 0 || n != math.Trunc(n) {
		return fmt.Sprintf("%s must be a non-negative integer", key)
	}
	return ""
}

// checkSubset rejects a count that exceeds the total it is a share of,
// when both are present as numbers.
func checkSubset(payload map[string]any, part, whole string) string {
	p, okP := payload[part].(float64)
	w, okW := payload[whole].(float64)
	if okP && okW && p > w {
		return fmt.Sprintf("%s must not exceed %s", part, whole)
	}
	return ""
}

func checkEnum(key string, v any, valid map[string]bool) string {
	s, ok := v.(string)
	if !ok || !valid[s] {
		return fmt.Sprintf("%s has an unsupported value", key)
	}
	return ""
}

func checkString(key string, v any, maxLen int) string {
	s, ok := v.(string)
	if !ok {
		return fmt.Sprintf("%s must be a string", key)
	}
	if len(s) > maxLen {
		return fmt.Sprintf("%s exceeds %d-character limit", key, maxLen)
	}
	return ""
}
