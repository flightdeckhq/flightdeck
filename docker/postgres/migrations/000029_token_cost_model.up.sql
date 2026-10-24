-- Token and cost model. LLM events gain the fields cost and analytics
-- sum or group by; everything else the providers report about a call
-- (one-hour cache writes, service tier, speed, data residency, server
-- tools, stop reason) stays in the payload JSONB.
--
-- Every new events column is nullable: "not reported" stays distinct
-- from zero, and rows from clients that do not send a field keep
-- working. The worker fills provider, billing_mode, platform and the
-- canonical model on write, and a background backfill fills rows that
-- were stored before it did.
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS tokens_reasoning BIGINT,
    ADD COLUMN IF NOT EXISTS provider         TEXT,
    ADD COLUMN IF NOT EXISTS billing_mode     TEXT,
    ADD COLUMN IF NOT EXISTS platform         TEXT,
    ADD COLUMN IF NOT EXISTS cost_reported    NUMERIC(14, 8),
    ADD COLUMN IF NOT EXISTS cost_source      TEXT,
    ADD COLUMN IF NOT EXISTS model_requested  TEXT,
    ADD COLUMN IF NOT EXISTS model_served     TEXT;

-- NOT VALID, deliberately and permanently: every existing row holds
-- NULL in the new columns and so satisfies the checks, which makes a
-- VALIDATE CONSTRAINT scan of the whole events table pointless. New and
-- updated rows are checked. Ingestion validates the same vocabularies
-- first, so these are a backstop against a direct publisher on the bus.
ALTER TABLE events
    ADD CONSTRAINT events_billing_mode_check
        CHECK (billing_mode IN ('metered', 'subscription', 'local')) NOT VALID,
    ADD CONSTRAINT events_provider_check
        CHECK (provider IN ('anthropic', 'openai', 'google', 'xai', 'mistral',
                            'meta', 'deepseek', 'other')) NOT VALID,
    ADD CONSTRAINT events_cost_source_check
        CHECK (cost_source IN ('provider', 'agent')) NOT VALID,
    ADD CONSTRAINT events_cost_reported_pair_check
        CHECK ((cost_reported IS NULL) = (cost_source IS NULL)) NOT VALID,
    ADD CONSTRAINT events_tokens_reasoning_check
        CHECK (tokens_reasoning >= 0) NOT VALID;

COMMENT ON COLUMN events.tokens_reasoning IS
    'Reasoning or thinking tokens, a subset of tokens_output; NULL when '
    'the provider reported none.';
COMMENT ON COLUMN events.provider IS
    'The model''s vendor (anthropic, openai, google, xai, mistral, meta, '
    'deepseek, other).';
COMMENT ON COLUMN events.billing_mode IS
    'How the call was paid for: metered, subscription or local. Only '
    'metered calls are counted in estimated cost.';
COMMENT ON COLUMN events.platform IS
    'The endpoint that served the call (provider_metadata.platform); '
    'selects the price list.';
COMMENT ON COLUMN events.cost_reported IS
    'USD cost a gateway or client reported for the call; preferred over '
    'the estimate.';
COMMENT ON COLUMN events.cost_source IS
    'Who reported cost_reported: provider (the API or gateway) or agent '
    '(the client).';
COMMENT ON COLUMN events.model_requested IS
    'The model id the caller asked for, verbatim.';
COMMENT ON COLUMN events.model_served IS
    'The model id the response named, verbatim.';

-- Prices for estimated cost. Derived data: the API rebuilds both tables
-- at startup from its built-in catalogue and pricing.yaml. Rates are USD
-- per million tokens.
CREATE TABLE IF NOT EXISTS model_pricing (
    model_id               TEXT NOT NULL,
    platform               TEXT NOT NULL,
    provider               TEXT NOT NULL,
    input                  NUMERIC(14, 6) NOT NULL,
    output                 NUMERIC(14, 6) NOT NULL,
    cache_read             NUMERIC(14, 6) NOT NULL,
    cache_write_5m         NUMERIC(14, 6) NOT NULL,
    cache_write_1h         NUMERIC(14, 6) NOT NULL,
    reasoning              NUMERIC(14, 6),
    tier_threshold_tokens  BIGINT,
    tier_input             NUMERIC(14, 6),
    tier_output            NUMERIC(14, 6),
    tier_cache_read        NUMERIC(14, 6),
    tier_cache_write_5m    NUMERIC(14, 6),
    tier_cache_write_1h    NUMERIC(14, 6),
    priority_multiplier    NUMERIC(8, 4),
    source                 TEXT NOT NULL CHECK (source IN ('catalogue', 'override', 'alias')),
    deprecated_on          DATE,
    PRIMARY KEY (model_id, platform)
);

CREATE TABLE IF NOT EXISTS model_pricing_meta (
    id           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    content_hash TEXT NOT NULL,
    loaded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
