-- Anthropic's fast mode is priced per model (the catalogue lists a
-- multiplier for each model that offers it), so it lives on the
-- model_pricing row beside the priority-tier ratio rather than as one
-- flat setting. NULL: the model has no fast-mode price.
ALTER TABLE model_pricing
    ADD COLUMN IF NOT EXISTS fast_multiplier NUMERIC(8, 4);
