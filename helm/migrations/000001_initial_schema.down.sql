-- Reverse initial schema: drop all tables in reverse dependency order

DROP TABLE IF EXISTS directives CASCADE;
DROP TABLE IF EXISTS event_content CASCADE;
DROP TABLE IF EXISTS events CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS agents CASCADE;
DROP TABLE IF EXISTS token_policies CASCADE;
DROP TABLE IF EXISTS api_tokens CASCADE;
