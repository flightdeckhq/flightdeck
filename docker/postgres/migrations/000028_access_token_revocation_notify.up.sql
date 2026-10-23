-- Revoking an access token is deleting its row. The ingestion API and
-- the query API cache successful validations in memory, so each process
-- must learn about a deletion to drop the cached entry; otherwise a
-- revoked token stays usable until the cache entry expires. This
-- trigger announces every deleted token id on a NOTIFY channel that both
-- services LISTEN on. A trigger (rather than a NOTIFY from the API's
-- delete handler) also covers rows deleted directly in SQL.
CREATE OR REPLACE FUNCTION notify_access_token_revoked() RETURNS trigger
    LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('flightdeck_access_token_revoked', OLD.id::text);
    RETURN OLD;
END;
$$;

CREATE TRIGGER access_tokens_notify_revoked
    AFTER DELETE ON access_tokens
    FOR EACH ROW
    EXECUTE FUNCTION notify_access_token_revoked();
