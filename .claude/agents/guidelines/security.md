# Security review guidelines

These rules are non-negotiable findings unless a project's CLAUDE.md
explicitly relaxes them with a documented threat model.

## 1. Authentication and authorization

- Authn (who is this) and authz (what can they do) are separate concerns. A working authn does not imply authz; check both at every protected boundary.
- Least privilege by default. Roles and scopes are additive, not subtractive. New endpoints require an explicit policy.
- Tokens travel in headers (`Authorization: Bearer <token>`), never in URLs, query parameters, referer-leakable spots, or browser history.
- Session timeouts have sensible defaults (idle and absolute). No session lives forever.
- Credentials never appear in logs, error messages, or stack traces.
- Privilege escalation is explicit: a role change has an audit log entry and an admin actor recorded.
- Service-to-service auth uses short-lived tokens or mTLS. Long-lived shared secrets between services are a finding.

## 2. Input validation at trust boundaries

- Validate at the boundary (HTTP handler, queue consumer, file ingest, CLI argv), never deep inside business logic.
- Reject before processing. Don't sanitize-and-continue when the input is malformed.
- Schemas are explicit and enforced (Pydantic, Zod, struct tags with validation, JSON schema). Implicit "any object will do" parsing is a finding.
- Maximum sizes on all dimensions: body length, query length, header count, JSON depth, array length, string length.
- Allowlists over blocklists wherever practical.

## 3. Injection defense

- SQL: parameterized queries only. Driver placeholders (`?`, `$1`, `:name`). String concatenation or f-string SQL is a critical finding even when the input "looks safe".
- Shell: `subprocess.run([cmd, arg, ...])` or `exec.Command(name, args...)` with separate args. `shell=True`, `sh -c "..."`, or `os.system` with user input is a critical finding.
- Path traversal: validate paths, normalize via `os.path.realpath` / `filepath.Clean`, reject anything escaping the allowed root. Check the resolved path is under the root after normalization.
- Templates: never render user-controlled text with the same template engine that processes trusted templates. Use sandboxed renderers or escape by default.
- Deserialization: never `pickle.loads`, `yaml.load` (use `safe_load`), Java `ObjectInputStream`, or PHP `unserialize` on untrusted data. JSON or msgpack only.
- XML: disable DTD and external entity resolution (`defusedxml` in Python, equivalents elsewhere). XXE is a real attack on real codebases.
- Regex: bound the input size before applying user-controlled patterns. Catastrophic backtracking is a DoS vector.
- LDAP, NoSQL, GraphQL: same parameterization principle. Don't string-concat queries.

## 4. Secrets discipline

- No hardcoded credentials, API keys, tokens, or private keys in source. CI scans for them with gitleaks / detect-secrets / trufflehog.
- Secrets sourced from env vars (small projects) or a secret manager (Vault, AWS Secrets Manager, GCP Secret Manager, etc.).
- `.env` files in `.gitignore`. `.env.example` checked in with placeholder values.
- Logs are scrubbed before write: redact `Authorization`, `Cookie`, `Set-Cookie`, `password`, `token`, `api_key`, and any field name configured as sensitive.
- Stack-trace dumps in production strip variable values. A leaked stack trace with `password = "hunter2"` is a breach.
- Secrets reach the client never. Anything in the JS bundle is public. Build-time `NEXT_PUBLIC_*` / `VITE_*` are public.
- Rotation is possible without redeploy: secrets are externalized, not baked into images.

## 5. Cryptography

- Use vetted libraries: `cryptography` (Python), `crypto/*` (Go), Web Crypto API or `crypto` (Node). Never roll your own.
- Password hashing: `bcrypt`, `argon2`, or `scrypt`. Never `SHA*` (with or without salt; the iteration count is what matters).
- Token generation: `secrets` (Python), `crypto/rand` (Go), `crypto.randomBytes` (Node), `crypto.getRandomValues` (browser). Never `random` / `math/rand`.
- Symmetric encryption: AES-256-GCM or ChaCha20-Poly1305. Never AES-ECB, never CBC without a MAC. Never reuse a (key, IV) pair.
- Asymmetric: RSA-2048+ (legacy), Ed25519 / X25519 (preferred), ECDSA P-256+ acceptable.
- HMAC for message authentication, not raw hash comparison.
- Constant-time compare for secrets: `hmac.compare_digest` (Python), `subtle.ConstantTimeCompare` (Go), `crypto.timingSafeEqual` (Node). `==` on a bearer token is a finding.
- Salts unique per record, stored alongside the hash. Salt length 16 bytes minimum.

## 6. Transport security

- TLS 1.2 minimum, TLS 1.3 preferred. Disable SSLv3, TLS 1.0, TLS 1.1.
- Certificate validation is always on. `verify=False`, `InsecureSkipVerify`, `rejectUnauthorized: false` are critical findings absent a documented threat model.
- HSTS on production web surfaces, with `includeSubDomains` and a sensible `max-age` (one year minimum after rollout).
- HTTP-to-HTTPS redirect at the edge for browser-facing services.
- Don't downgrade protocols on retry.

## 7. Web HTTP defenses

- CSRF: tokens on state-changing requests OR `SameSite=Strict` (or `Lax` if the flow needs it) on session cookies. Don't rely on `Origin` / `Referer` alone.
- XSS: output is escaped by default (the framework's templating, React's JSX, Vue's `{{ }}`). When rendering HTML user content, sanitize via DOMPurify or equivalent.
- `dangerouslySetInnerHTML` (React), `innerHTML =` (vanilla), `v-html` (Vue), `[innerHTML]` (Angular) on user content is a critical finding without sanitization.
- CSP: configured intentionally. Block inline scripts and inline styles by default; allow with nonces or hashes only.
- CORS: never `Access-Control-Allow-Origin: *` on a credentialed endpoint. Allowlist origins explicitly.
- Clickjacking: `X-Frame-Options: DENY` (or `SAMEORIGIN`) or CSP `frame-ancestors`. One or the other on every UI-serving response.
- Cookies: `HttpOnly` for session cookies, `Secure` on every cookie that travels over HTTPS, `SameSite` set deliberately.
- Subresource Integrity (`integrity=` attribute) on third-party scripts and stylesheets.
- `Referrer-Policy: strict-origin-when-cross-origin` minimum.
- Disable `X-Powered-By` and similar fingerprinting headers.

## 8. Information disclosure

- Generic error messages to clients in production. Detailed messages to server logs.
- Stack traces are never returned to clients in production. Debug mode is off in deployed builds.
- 401 vs 403 vs 404 are deliberate: an unauthenticated user gets 401, an unauthorized one gets 403 or 404 (4 04 if revealing existence is itself sensitive).
- Don't include internal hostnames, IPs, or full file paths in error responses.
- Verbose-mode toggles (Django `DEBUG=True`, Flask debug, Express `NODE_ENV=development`) off in prod, with CI / startup checks.
- Health check and metrics endpoints are not auth-bypass paths to internal data.

## 9. Logging and PII

- Define a sensitive-fields list per service. The list is enforced by a redaction layer in the logger.
- No passwords, tokens, full PANs, full SSNs, full DOBs, or session identifiers in logs. Hashes or last-four substrings only when needed.
- PII at rest: classify what is PII for the project, document the path through the system. Encrypt sensitive fields at the database column level when justified.
- Audit log for sensitive actions: who, when, what, from where. Append-only, with retention policy.
- Crash dumps and exception payloads scrub variable values, not just headers.

## 10. Data lifecycle

- PII identified, classified, and tracked. A doc states what is collected, why, where it lives, how long it is retained.
- Data minimization: collect only what the product needs. Retention policies that auto-delete or auto-anonymize after the documented window.
- Encryption at rest for sensitive data (DB, backups, log archives, object storage).
- Right-to-deletion paths exist if regulated (GDPR, CCPA, etc.).
- Tokenization for highly sensitive fields when justified (credit cards, SSNs).
- Backups encrypted, access-controlled, restore-tested.

## 11. Dependencies and vulnerability scanning

- Lockfiles committed: `package-lock.json` / `yarn.lock` / `Pipfile.lock` / `go.sum` / `Cargo.lock`.
- Vulnerability scan in CI: `npm audit --audit-level=high`, `pip-audit`, `govulncheck`, `cargo audit`, etc. Builds fail on CRITICAL / HIGH unless an exception is documented.
- Automated dependency bumps (Dependabot, Renovate) configured.
- Pin majors, allow patch updates by default. Major bumps go through review.
- License compliance: no GPL / AGPL in a permissively-licensed product. Tooling (`license-checker`, `pip-licenses`, `go-licenses`) in CI.
- Transitive dependencies audited before majors. Top-N transitive deps (by surface area) get a manual look.

## 12. Build, runtime, and supply chain

- Containers don't run as `root` (`USER` directive in Dockerfile, `runAsNonRoot: true` in k8s).
- Minimal base images: `gcr.io/distroless/*`, `alpine`, or `scratch`. Avoid `latest` tags; pin SHAs.
- Drop unnecessary capabilities (`--cap-drop=ALL`, then add what's needed).
- Resource limits set (CPU, memory) to prevent DoS via co-tenant noise.
- Read-only root filesystems where the workload allows.
- Network policies: deny by default, allow specific ingress/egress.
- Image signing (cosign / sigstore) and verification at deploy.
- SBOM generated for releases. Document third-party origins.
- No `curl | bash` install paths in CI or developer onboarding without verifying a signed checksum.

## 13. API rate limiting and abuse

- Every public endpoint rate-limited per principal. Anonymous endpoints rate-limited per IP / fingerprint. Token-bucket or sliding-window, not naive counter.
- Per-endpoint limits sized by cost, not a uniform default.
- Outbound calls have backoff and circuit breakers (`pybreaker`, `gobreaker`, `opossum`). Failed external dependencies don't amplify into a thundering herd.
- Input size limits (max body, max query, max header count, max JSON depth) enforced at the framework or middleware layer.
- Idempotency keys on retry-safe mutations. Servers honor the key, deduplicate within a window.
- Pagination cursors don't leak resource IDs the user can't access. Validate the cursor's principal at fetch time.
- File-upload paths bound size and validate type by content (magic bytes), not just by extension or MIME header.

## 14. AI and LLM-specific safety

- Treat user-controlled text reaching the model as untrusted. Separate trusted instructions (system prompt) from untrusted data (user input). System prompts not concatenated with user input verbatim.
- Output validated against a schema. Use JSON mode, function calling, or constrained decoding when available. Don't render free-text model output as HTML, code, or commands.
- Per-user / per-tenant token budgets. Cost runaway is an abuse vector.
- Model identifiers and parameters pinned, not dynamic from user input.
- Prompt-injection defense: when the model orchestrates tool calls, every tool result is treated as untrusted text on the next turn. Don't execute model-emitted shell or SQL without human-in-the-loop or a strict allowlist.
- Fallback paths (timeout, error, refusal) don't echo system instructions or internal context to the user.
- PII: documented decision on what reaches the model, what the provider logs, what your service stores.
- Hallucination mitigation: retrieval grounding, citations, or constrained outputs where stakes are real.
- Tool-call authorization: the model can only invoke tools the calling principal is authorized to call. Authz at the tool layer, not at the model layer.

## 15. Capture posture (for projects with a capture flag)

When the project has a capture toggle (e.g. a `capture_prompts` gate that controls whether prompt content is stored), enforce it strictly. The pattern below applies; project CLAUDE.md adapts the names.

- When capture is off, no prompt content is stored or logged. Only metadata (token counts, model identifiers, latency, tool names).
- Content lives in a separate table or store from the metadata. Metadata never embeds the content fields.
- Content is fetched on demand by an endpoint that returns 404 (not 200-with-empty) when capture is off for that record.
- Provider-specific structures preserved. Don't normalize Anthropic's `system + messages` into OpenAI's `messages`-only format or vice versa.
- The user-facing surface communicates capture state (a clear disabled-state message, not an empty tab or perpetual spinner).
- A single bug that stores content under capture-off is a critical finding. The gate is the contract.

## 16. Race conditions and TOCTOU

- Time-of-check vs time-of-use: stat-then-open is a different operation from open-then-stat. Use the fd, not the path, after the check.
- Authz tied to the action atomically. Don't pre-authorize then act on a different reference.
- File operations: `os.path.exists` followed by `open` is a TOCTOU pattern. Use `try / except FileNotFoundError` or `O_CREAT | O_EXCL`.
- Database: `SELECT ... FOR UPDATE` or optimistic concurrency tokens for read-modify-write under contention.
- Ownership checks: validate the resource belongs to the principal in the same transaction that mutates it.

## Testing posture for security

- Negative authz tests on every protected endpoint: unauthenticated, wrong-role, cross-tenant, expired-token, malformed-token. Not just the happy path.
- Fuzzing for parsers and serializers (`atheris`, `go-fuzz`, `cargo-fuzz`).
- Static analysis in CI (`bandit`, `gosec`, `semgrep` with security rulesets, `eslint-plugin-security`).
- Dynamic scanning (OWASP ZAP, Burp) for web apps before any first public release.
- Penetration test before any v1 ship handling untrusted users.
- Security-relevant unit tests (constant-time compare, salt presence, CSP header, cookie attributes, redaction).

## How I report

```
## Security review summary
- Files reviewed: <list>
- Surface touched: <auth / crypto / web / data / supply chain / ai / etc>
- Threat model relevance: <which categories from this guideline applied>

## Critical (must fix)
- <file:line> — <issue> — <category from guidelines> — <how to fix>

## Warnings (should fix)
- ...

## Suggestions (defense in depth)
- ...

## Test gaps
- <missing negative-path test, missing fuzz target, missing static rule>

## Verdict
- CLEAN if no critical and no warnings.
- DIRTY otherwise.
```

## Project-specific notes

<!-- Add per-project rules here. Example: documented exception
to a guideline, project-specific allowed crypto suites, project's
secret-management vendor, capture-flag specifics. -->
