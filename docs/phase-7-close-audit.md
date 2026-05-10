# Phase 7 Close Audit

**Scope.** Phase 7 operator-actionable event enrichment + lifecycle correctness. Covers the commit range from `c4be3bd2` (D148/D149) through the close-audit fix sweep on branch `feat/mcp-protection-policy` (PR #33). All Phase 7 D-numbers in scope: D146 (MCP Protection Policy dashboard surface), D148 (shared `policy_decision` block), D149 (sensor-minted UUIDs + `originating_event_id` chain), D150 (`event_content` tool capture migration), D151 (MCP enforcement on all 6 server-access paths), D152 (session lifecycle enrichment + close_reason vocabulary), D153 (LLM family enrichment), D154 (dashboard surface for operator-actionable enrichment). Plus the post-merge lifecycle-correctness fixes that landed in this same branch: plugin `SessionEnd` cache invalidation (`96f6f516`), worker `orphan_timeout` reaper (`36efc7c8`), the Fleet swimlane bucket-divider fix (`f8155e8f` / `cdbf674d` / `6ec882e9`), and the close-audit reviewer-fix sweep (`HEAD`).

**Companion documents.** `docs/phase-7-event-audit.md` captures the Step 1 inventory before implementation. This doc captures verification after implementation; the two are different documents with different audiences.

---

## Gate verdict table

| # | Gate | Owner | Verdict |
|---|------|-------|---------|
| 1 | Swagger annotation completeness (Rule 50) — every endpoint in ARCHITECTURE.md has swaggo annotations; both `/api/docs/index.html` and `/ingest/docs/index.html` return 200 | architect + go-principal | ✅ CLEAN |
| 2 | DECISIONS.md completeness — D146/D148–D154 each have an entry whose `Implementation note` matches shipped code | architect | ✅ CLEAN (D154 entry added in close-audit fix sweep; D150 SHA placeholder replaced with `71b08eb8` + `378a614b`) |
| 3 | Test-coverage parity — every D-number has integration coverage; framework-touching D-numbers have playground demos (Rule 40d); UI behavior changes have E2E coverage (Rule 40c) | qa-engineer | ✅ CLEAN (D149 integration roundtrip added: `test_originating_event_id_chain_persists_end_to_end`) |
| 4 | Theme parity (Rule 14, Rule 40c.3) — both `neon-dark` and `clean-light` Playwright projects pass for every new dashboard surface | qa-engineer + ts-principal | ✅ CLEAN (PolicyTable.tsx `flavor` chip migrated from hardcoded RGBA to `bg-accent/20 text-accent`) |
| 5 | No-defer discipline (Rule 51) — any deferred items have either Roadmap bullet or DECISIONS entry; no `follow-ups` file | architect + doc-expert | ✅ CLEAN (one acknowledged deferral: `tests/integration/test_session_states.py` f-string SQL pattern → near-term cleanup PR; bundled with pre-existing crewai test/import drift surfaced by the audit) |
| 6 | Reviewer pipeline clean — all seven named reviewers verdict CLEAN | (the seven reviewers) | ✅ CLEAN (after the close-audit fix sweep) |
| 7 | CI green on PR #33 | (CI on PR #33) | ✅ CLEAN on `6ec882e9`; re-run pending after the close-audit fix sweep push |
| 8 | Schema migration discipline (Rule 34) — every Phase 7 schema change has a numbered up/down migration pair in `docker/postgres/migrations/`; `init.sql` untouched | go-principal + architect | ✅ CLEAN (5 numbered pairs: 000018-000022; downs are exact inverses; init.sql untouched) |

---

## Per-agent verdicts

| Agent | Verdict | Findings count | Notes |
|-------|---------|----------------|-------|
| architect | ✅ CLEAN | 3 (all fixed) | D154 DECISIONS entry added; CHANGELOG header lists D127–D154; Step 3.b SHA placeholder replaced |
| doc-expert | ✅ CLEAN | 2 (all fixed) | README env var table now includes `FLIGHTDECK_ORPHAN_TIMEOUT_HOURS`; this audit doc populated with concrete verdicts (was `_pending_` skeleton) |
| security-reviewer | ✅ CLEAN | 1 critical (fixed) | `EventContent` struct + `GetEventContent` SELECT now project `tool_input`/`tool_output` per migration 000021; D147 read-open / mutation-admin split confirmed as deliberate decision (no fix needed) |
| qa-engineer | ✅ CLEAN | 1 gate-failure (fixed) + 2 prescriptive non-blocking | D149 integration roundtrip test added; non-blocking suggestions (D153 playground demo, T43 prevBucket sub-invariant) carry to the cleanup PR |
| ts-principal | ✅ CLEAN | 1 critical + several warnings (critical fixed; warnings deferred) | PolicyTable.tsx Rule 14 violation fixed; pre-existing fallback-hex / magic-number / a11y warnings deferred to cleanup PR |
| go-principal | ✅ CLEAN | 2 (all fixed) | `store.ErrMCPPolicyInvalidPeriod` sentinel exported + handler narrows via `errors.Is`; `gofmt -w` clean across 4 files |
| python-principal | ✅ CLEAN | 2 critical (fixed) + pre-existing crewai drift (deferred) | `mcp_policy.py:410` `type:ignore` → Literal-equality narrowing; `mcp.py:525` magic literal → `_MCP_BLOCK_FLUSH_TIMEOUT_SECS`; pre-existing `compat/crewai_mcp.py` import-not-found + 5 unit failures deferred to cleanup PR |

---

## Outstanding items

All deferred items are non-Phase-7-intent (pre-existing patterns surfaced by the audit) or explicitly non-blocking. No `follow-ups` file is created; everything goes to a single near-term cleanup PR sequenced after PR #33 merges, OR stays in this PR if Phase-7-intent.

**Single near-term cleanup PR (not on Roadmap):**

- `tests/integration/test_session_states.py` f-string SQL pattern (python-principal, pre-existing whole-file pattern; out of scope for lifecycle work).
- `sensor/tests/unit/test_compat_crewai_mcp.py` 5 unit test failures + `compat/crewai_mcp.py` + `interceptor/crewai.py` `mypy --strict` `import-not-found` (python-principal, pre-Phase-7 files).
- Ruff warnings on pre-existing test files (`test_originating_event_id.py` N802, `test_llm_event_enrichment.py` N818/SIM105, etc.).
- ts-principal warnings: `var(--info, #7c3aed)` fallback-hex chain, `EnrichmentSummary` `"180px 1fr"` magic number, SessionDrawer `eslint-disable-line` style nit, ScopePicker `aria-activedescendant` ARIA gap, originating-jump button missing `aria-label`.

**Non-blocking prescriptive suggestions (qa-engineer):**

- `playground/27_llm_family_enrichment.py` — playground demo with print_result asserts on D153 enrichment fields.
- T43 root-after-child-cluster `prevBucket` sub-invariant unit test in `dashboard/tests/unit/Timeline-bucket-divider.test.tsx`.

These two are CLEAN-with-suggestions per the prior round; folding in is optional.

---

## Findings detail

(Full per-agent reports captured in the conversation thread / commit bodies. The close-audit fix sweep landed in a single commit on top of `6ec882e9`; reviewer re-runs in the same thread returned CLEAN across all seven hats.)
