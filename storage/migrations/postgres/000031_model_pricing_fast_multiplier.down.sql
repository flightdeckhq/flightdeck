-- Inverse of 000031: drop the per-model fast-mode multiplier.
ALTER TABLE model_pricing
    DROP COLUMN IF EXISTS fast_multiplier;
