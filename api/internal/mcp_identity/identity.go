// Package mcp_identity is the Go twin of
// sensor/flightdeck_sensor/interceptor/mcp_identity.py and
// plugin/hooks/scripts/mcp_identity.mjs.
//
// All three implementations MUST produce byte-identical output for
// identical inputs. The cross-language fixture vectors at
// tests/fixtures/mcp_identity_vectors.json lock all three surfaces
// against drift. identity_test.go iterates the same JSON; if the Go
// canonicalisation drifts from Python or JS, the Go suite fails.
//
// Identity is the pair (URL, name). The URL is the security key;
// the name is display + tamper-evidence (D127). The full SHA-256 of
// canonical_url + 0x00 + name is the storage key (mcp_policy_entries.
// fingerprint stores the 16-char display fingerprint per the schema).
//
// Pure stdlib (net/url, crypto/sha256, encoding/hex, os, regexp,
// strings).
//
// See DECISIONS.md D127 for the full rationale and ARCHITECTURE.md
// "MCP Protection Policy" → "Identity model" for the contract.
package mcp_identity

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
)

// Default ports stripped from HTTP canonical form. A declaration of
// `https://host:443/path` and `https://host/path` produce the same
// fingerprint — the explicit port is cosmetic when it matches the
// scheme default.
var defaultPorts = map[string]string{
	"http":  "80",
	"https": "443",
}

// Env-var regex matches `$VAR` and `${VAR}` shapes. POSIX-style only —
// no tilde expansion (D127 limits resolution to env vars). Unresolved
// variables (not present in os.Environ) remain LITERAL in the
// canonical form: `${MISSING_VAR}` stays `${MISSING_VAR}`. Keeping
// unresolved vars literal means a missing env var produces a stable
// fingerprint that doesn't accidentally match another agent's empty-
// string substitution.
var envVarRE = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)`)

// Whitespace collapse applies globally inside the stdio canonical
// form (Assumption Y locked in step 2). Every run of whitespace
// becomes a single space; leading and trailing whitespace are
// stripped. An arg containing multi-space whitespace collapses by
// design — callers should normalize args before declaring them.
// Documented in README.md "MCP Protection Policy" → "Troubleshooting".
var whitespaceRunRE = regexp.MustCompile(`\s+`)

func resolveEnvVars(raw string) string {
	return envVarRE.ReplaceAllStringFunc(raw, func(match string) string {
		// regexp doesn't expose submatches inside ReplaceAllStringFunc;
		// re-match to recover the captured group name.
		groups := envVarRE.FindStringSubmatch(match)
		if len(groups) < 3 {
			return match
		}
		name := groups[1]
		if name == "" {
			name = groups[2]
		}
		// os.LookupEnv returns ok=false when the var is unset;
		// preserves literal form so missing-env vectors stay
		// deterministic.
		if val, ok := os.LookupEnv(name); ok {
			return val
		}
		return match
	})
}

func canonicalizeHTTP(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("parse http url: %w", err)
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	port := u.Port()

	netloc := host
	if port != "" && defaultPorts[scheme] != port {
		netloc = host + ":" + port
	}

	path := u.Path
	// Strip trailing slash only at the root. `/api/` keeps its
	// slash because path semantics carry beyond root.
	if path == "/" {
		path = ""
	}

	// Drop user-info (u.User), fragment (u.Fragment), query
	// (u.RawQuery) by reconstructing manually.
	return fmt.Sprintf("%s://%s%s", scheme, netloc, path), nil
}

func canonicalizeStdio(raw string) string {
	body := raw
	if strings.HasPrefix(strings.ToLower(body), "stdio://") {
		body = body[len("stdio://"):]
	}
	body = resolveEnvVars(body)
	body = whitespaceRunRE.ReplaceAllString(body, " ")
	body = strings.TrimSpace(body)
	return "stdio://" + body
}

// CanonicalizeURL reduces raw to its canonical form per D127.
//
// HTTP / HTTPS URLs route to the HTTP canonicalisation. Anything else
// routes to the stdio canonicalisation, which prepends `stdio://` if
// missing. The lenient default lets callers pass a bare
// `"npx -y package"` command and still get a deterministic
// fingerprint.
//
// Returns an error only on HTTP parse failure; stdio path never
// errors. An empty string returns `"stdio://"`. A whitespace-only
// string returns `"stdio://"`.
func CanonicalizeURL(raw string) (string, error) {
	lower := strings.ToLower(raw)
	if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
		return canonicalizeHTTP(raw)
	}
	return canonicalizeStdio(raw), nil
}

// Fingerprint is the full 64-character hex SHA-256 of
// `canonicalURL + 0x00 + name`. The 0x00 separator prevents
// collisions between (https://a.com, bservice) and
// (https://a.combservice, "") — without a non-printable separator a
// plain concatenation hash collides on those.
func Fingerprint(canonicalURL, name string) string {
	// fmt.Sprintf with %s\x00%s is byte-equivalent to the Python
	// `canonical_url + "\0" + name` and the JS `${canonicalUrl}\u0000${name}`.
	// Go strings are byte sequences so \x00 is the literal NUL byte
	// at compile time without binary-blob trouble.
	payload := fmt.Sprintf("%s\x00%s", canonicalURL, name)
	sum := sha256.Sum256([]byte(payload))
	return hex.EncodeToString(sum[:])
}

// FingerprintShort is the first 16 hex characters of Fingerprint —
// the display fingerprint surfaced in the dashboard and in policy
// entries.
func FingerprintShort(canonicalURL, name string) string {
	return Fingerprint(canonicalURL, name)[:16]
}
