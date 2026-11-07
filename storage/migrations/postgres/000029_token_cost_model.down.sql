-- Inverse of 000029: drop the pricing tables and the token and cost
-- columns with their constraints. Roll back only together with the
-- worker and API code that writes and reads them.
DROP TABLE IF EXISTS model_pricing_meta;
DROP TABLE IF EXISTS model_pricing;

ALTER TABLE events
    DROP CONSTRAINT IF EXISTS events_tokens_reasoning_check,
    DROP CONSTRAINT IF EXISTS events_cost_reported_pair_check,
    DROP CONSTRAINT IF EXISTS events_cost_source_check,
    DROP CONSTRAINT IF EXISTS events_provider_check,
    DROP CONSTRAINT IF EXISTS events_billing_mode_check;

ALTER TABLE events
    DROP COLUMN IF EXISTS model_served,
    DROP COLUMN IF EXISTS model_requested,
    DROP COLUMN IF EXISTS cost_source,
    DROP COLUMN IF EXISTS cost_reported,
    DROP COLUMN IF EXISTS platform,
    DROP COLUMN IF EXISTS billing_mode,
    DROP COLUMN IF EXISTS provider,
    DROP COLUMN IF EXISTS tokens_reasoning;
