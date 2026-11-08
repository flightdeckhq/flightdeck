CREATE TABLE custom_directives (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint   TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    description   TEXT,
    flavor        TEXT NOT NULL,
    parameters    JSONB,
    registered_at TIMESTAMPTZ DEFAULT now(),
    last_seen_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX custom_directives_flavor_idx ON custom_directives(flavor);
CREATE INDEX custom_directives_fp_idx ON custom_directives(fingerprint);
