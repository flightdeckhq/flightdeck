-- D096: rename api_tokens → access_tokens so the auth-credential
-- storage is unambiguous with respect to the many "token" fields
-- that count LLM input/output tokens (events.tokens_input,
-- sessions.tokens_used, token_policies.token_limit, etc.).
--
-- The sessions.token_id FK column deliberately keeps its name --
-- renaming every call site that reads sessions.token_id would
-- ripple through store/handler/worker code for no semantic gain,
-- and the FK already points at the renamed table through its
-- constraint, not through the column name.

ALTER TABLE api_tokens RENAME TO access_tokens;

ALTER INDEX api_tokens_pkey        RENAME TO access_tokens_pkey;
ALTER INDEX api_tokens_token_hash_key RENAME TO access_tokens_token_hash_key;
ALTER INDEX api_tokens_prefix_idx  RENAME TO access_tokens_prefix_idx;
