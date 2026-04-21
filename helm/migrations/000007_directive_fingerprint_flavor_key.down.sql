ALTER TABLE custom_directives
    DROP CONSTRAINT IF EXISTS custom_directives_fingerprint_flavor_key;

ALTER TABLE custom_directives
    ADD CONSTRAINT custom_directives_fingerprint_key
        UNIQUE (fingerprint);
