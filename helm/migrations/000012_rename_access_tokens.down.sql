-- Exact inverse of 000012_rename_access_tokens.up.sql.

ALTER INDEX access_tokens_prefix_idx  RENAME TO api_tokens_prefix_idx;
ALTER INDEX access_tokens_token_hash_key RENAME TO api_tokens_token_hash_key;
ALTER INDEX access_tokens_pkey        RENAME TO api_tokens_pkey;

ALTER TABLE access_tokens RENAME TO api_tokens;
