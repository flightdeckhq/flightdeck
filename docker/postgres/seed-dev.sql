-- Dev seed data: agents, sessions, and events spread across the
-- last 14 days. Rewritten for the v0.4.0 Phase 1 agent identity
-- model (D115); run AFTER migrations have applied the full schema:
--   docker exec -i docker-postgres-1 psql -U flightdeck flightdeck < docker/postgres/seed-dev.sql
--
-- Every agents.agent_id is a deterministic name-based UUID that
-- matches what the sensor / plugin would derive for the same
-- (agent_type, user, hostname, client_type, agent_name) tuple.
-- Hand-computed so the seed is reproducible and greppable.

INSERT INTO agents (agent_id, agent_type, client_type, agent_name, user_name, hostname, first_seen_at, last_seen_at, total_sessions, total_tokens)
VALUES
  ('b0000000-0000-4000-8000-00000000000a', 'coding',     'flightdeck_sensor', 'code-review',   'svc-review', 'dev-01',  NOW() - INTERVAL '14 days', NOW(), 6, 26000),
  ('b0000000-0000-4000-8000-00000000000b', 'production', 'flightdeck_sensor', 'support-bot',   'svc-support','prod-01', NOW() - INTERVAL '14 days', NOW(), 4, 22000),
  ('b0000000-0000-4000-8000-00000000000c', 'production', 'flightdeck_sensor', 'data-pipeline', 'svc-data',   'etl-01',  NOW() - INTERVAL '10 days', NOW(), 4, 39000)
ON CONFLICT (agent_id) DO NOTHING;

-- 14 sessions spread across 14 days. Every session is linked to an
-- agent_id via the sessions.agent_id FK; the legacy sessions.flavor
-- column carries the same free-form label the sensor emitted so
-- dashboards that still surface flavor keep rendering sensibly.
INSERT INTO sessions (session_id, flavor, agent_type, agent_id, client_type, agent_name, host, framework, model, state, started_at, last_seen_at, ended_at, tokens_used, context)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'code-review',   'coding',     'b0000000-0000-4000-8000-00000000000a', 'flightdeck_sensor', 'code-review',   'dev-01', 'langchain', 'claude-sonnet-4-6',  'closed', NOW() - INTERVAL '13 days', NOW() - INTERVAL '13 days' + INTERVAL '25 minutes', NOW() - INTERVAL '13 days' + INTERVAL '25 minutes', 4200, '{"os":"Linux","hostname":"dev-01","user":"svc-review","git_branch":"main","orchestration":"docker"}'),
  ('a0000000-0000-0000-0000-000000000002', 'support-bot',   'production', 'b0000000-0000-4000-8000-00000000000b', 'flightdeck_sensor', 'support-bot',   'prod-01','anthropic',  'claude-sonnet-4-6',  'closed', NOW() - INTERVAL '12 days', NOW() - INTERVAL '12 days' + INTERVAL '40 minutes', NOW() - INTERVAL '12 days' + INTERVAL '40 minutes', 8700, '{"os":"Linux","hostname":"prod-01","user":"svc-support","git_branch":"release/v2","orchestration":"kubernetes"}'),
  ('a0000000-0000-0000-0000-000000000003', 'code-review',   'coding',     'b0000000-0000-4000-8000-00000000000a', 'flightdeck_sensor', 'code-review',   'dev-02', 'langchain', 'gpt-4o',             'closed', NOW() - INTERVAL '11 days', NOW() - INTERVAL '11 days' + INTERVAL '15 minutes', NOW() - INTERVAL '11 days' + INTERVAL '15 minutes', 3100, '{"os":"Darwin","hostname":"dev-02","user":"svc-review","git_branch":"feat/search","orchestration":"docker-compose"}'),
  ('a0000000-0000-0000-0000-000000000004', 'data-pipeline', 'production', 'b0000000-0000-4000-8000-00000000000c', 'flightdeck_sensor', 'data-pipeline', 'etl-01', 'openai',    'gpt-4o',             'closed', NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days' + INTERVAL '60 minutes', NOW() - INTERVAL '10 days' + INTERVAL '60 minutes', 12500,'{"os":"Linux","hostname":"etl-01","user":"svc-data","orchestration":"kubernetes"}'),
  ('a0000000-0000-0000-0000-000000000005', 'code-review',   'coding',     'b0000000-0000-4000-8000-00000000000a', 'flightdeck_sensor', 'code-review',   'dev-01', 'langchain', 'claude-sonnet-4-6',  'closed', NOW() - INTERVAL '9 days',  NOW() - INTERVAL '9 days'  + INTERVAL '30 minutes', NOW() - INTERVAL '9 days'  + INTERVAL '30 minutes', 5600, '{"os":"Linux","hostname":"dev-01","user":"svc-review","git_branch":"main","orchestration":"docker"}'),
  ('a0000000-0000-0000-0000-000000000006', 'support-bot',   'production', 'b0000000-0000-4000-8000-00000000000b', 'flightdeck_sensor', 'support-bot',   'prod-02','anthropic',  'claude-haiku-4-5-20251001','closed', NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days' + INTERVAL '20 minutes', NOW() - INTERVAL '8 days' + INTERVAL '20 minutes', 2100, '{"os":"Linux","hostname":"prod-02","user":"svc-support","git_branch":"main","orchestration":"kubernetes"}'),
  ('a0000000-0000-0000-0000-000000000007', 'data-pipeline', 'production', 'b0000000-0000-4000-8000-00000000000c', 'flightdeck_sensor', 'data-pipeline', 'etl-01', 'openai',    'gpt-4o',             'closed', NOW() - INTERVAL '7 days',  NOW() - INTERVAL '7 days'  + INTERVAL '45 minutes', NOW() - INTERVAL '7 days'  + INTERVAL '45 minutes', 9800, '{"os":"Linux","hostname":"etl-01","user":"svc-data","orchestration":"kubernetes"}'),
  ('a0000000-0000-0000-0000-000000000008', 'code-review',   'coding',     'b0000000-0000-4000-8000-00000000000a', 'flightdeck_sensor', 'code-review',   'dev-03', 'langchain', 'claude-sonnet-4-6',  'closed', NOW() - INTERVAL '6 days',  NOW() - INTERVAL '6 days'  + INTERVAL '35 minutes', NOW() - INTERVAL '6 days'  + INTERVAL '35 minutes', 6300, '{"os":"Windows","hostname":"dev-03","user":"svc-review","git_branch":"feat/dashboard","orchestration":"docker-compose"}'),
  ('a0000000-0000-0000-0000-000000000009', 'support-bot',   'production', 'b0000000-0000-4000-8000-00000000000b', 'flightdeck_sensor', 'support-bot',   'prod-01','anthropic',  'claude-sonnet-4-6',  'closed', NOW() - INTERVAL '5 days',  NOW() - INTERVAL '5 days'  + INTERVAL '50 minutes', NOW() - INTERVAL '5 days'  + INTERVAL '50 minutes', 7400, '{"os":"Linux","hostname":"prod-01","user":"svc-support","git_branch":"release/v2","orchestration":"kubernetes"}'),
  ('a0000000-0000-0000-0000-000000000010', 'data-pipeline', 'production', 'b0000000-0000-4000-8000-00000000000c', 'flightdeck_sensor', 'data-pipeline', 'etl-02', 'openai',    'o3-mini',            'closed', NOW() - INTERVAL '4 days',  NOW() - INTERVAL '4 days'  + INTERVAL '55 minutes', NOW() - INTERVAL '4 days'  + INTERVAL '55 minutes', 15200,'{"os":"Linux","hostname":"etl-02","user":"svc-data","orchestration":"cloud-run"}'),
  ('a0000000-0000-0000-0000-000000000011', 'code-review',   'coding',     'b0000000-0000-4000-8000-00000000000a', 'flightdeck_sensor', 'code-review',   'dev-01', 'langchain', 'claude-sonnet-4-6',  'closed', NOW() - INTERVAL '3 days',  NOW() - INTERVAL '3 days'  + INTERVAL '20 minutes', NOW() - INTERVAL '3 days'  + INTERVAL '20 minutes', 3800, '{"os":"Linux","hostname":"dev-01","user":"svc-review","git_branch":"main","orchestration":"docker"}'),
  ('a0000000-0000-0000-0000-000000000012', 'support-bot',   'production', 'b0000000-0000-4000-8000-00000000000b', 'flightdeck_sensor', 'support-bot',   'prod-02','anthropic',  'claude-haiku-4-5-20251001','closed', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days' + INTERVAL '30 minutes', NOW() - INTERVAL '2 days' + INTERVAL '30 minutes', 4500, '{"os":"Linux","hostname":"prod-02","user":"svc-support","git_branch":"main","orchestration":"kubernetes"}'),
  ('a0000000-0000-0000-0000-000000000013', 'code-review',   'coding',     'b0000000-0000-4000-8000-00000000000a', 'flightdeck_sensor', 'code-review',   'dev-02', 'langchain', 'gpt-4o',             'closed', NOW() - INTERVAL '1 day',   NOW() - INTERVAL '1 day'   + INTERVAL '40 minutes', NOW() - INTERVAL '1 day'   + INTERVAL '40 minutes', 5100, '{"os":"Darwin","hostname":"dev-02","user":"svc-review","git_branch":"feat/search","orchestration":"docker-compose"}'),
  ('a0000000-0000-0000-0000-000000000014', 'data-pipeline', 'production', 'b0000000-0000-4000-8000-00000000000c', 'flightdeck_sensor', 'data-pipeline', 'etl-01', 'openai',    'gpt-4o',             'active', NOW() - INTERVAL '2 hours', NOW(),                                              NULL,                                              1800, '{"os":"Linux","hostname":"etl-01","user":"svc-data","orchestration":"kubernetes"}')
ON CONFLICT (session_id) DO NOTHING;

-- Events: 2-3 per session, spread to match session timestamps.
-- flavor column on events is carried through unchanged (the events
-- table keeps flavor for legacy analytics / filters).
INSERT INTO events (session_id, flavor, event_type, model, tokens_input, tokens_output, tokens_total, latency_ms, has_content, occurred_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'code-review',   'post_call', 'claude-sonnet-4-6',  800, 600, 1400, 1200, false, NOW() - INTERVAL '13 days' + INTERVAL '5 minutes'),
  ('a0000000-0000-0000-0000-000000000001', 'code-review',   'post_call', 'claude-sonnet-4-6',  1200, 900, 2100, 1800, false, NOW() - INTERVAL '13 days' + INTERVAL '15 minutes'),
  ('a0000000-0000-0000-0000-000000000001', 'code-review',   'tool_call','claude-sonnet-4-6',  300, 400, 700,  400,  false, NOW() - INTERVAL '13 days' + INTERVAL '20 minutes'),
  ('a0000000-0000-0000-0000-000000000002', 'support-bot',   'post_call', 'claude-sonnet-4-6',  2000, 1500, 3500, 2200, false, NOW() - INTERVAL '12 days' + INTERVAL '10 minutes'),
  ('a0000000-0000-0000-0000-000000000002', 'support-bot',   'post_call', 'claude-sonnet-4-6',  2500, 2700, 5200, 3100, false, NOW() - INTERVAL '12 days' + INTERVAL '25 minutes'),
  ('a0000000-0000-0000-0000-000000000003', 'code-review',   'post_call', 'gpt-4o',             900, 700, 1600, 900,  false, NOW() - INTERVAL '11 days' + INTERVAL '5 minutes'),
  ('a0000000-0000-0000-0000-000000000003', 'code-review',   'post_call', 'gpt-4o',             700, 800, 1500, 1100, false, NOW() - INTERVAL '11 days' + INTERVAL '10 minutes'),
  ('a0000000-0000-0000-0000-000000000004', 'data-pipeline', 'post_call', 'gpt-4o',             3000, 2500, 5500, 2800, false, NOW() - INTERVAL '10 days' + INTERVAL '15 minutes'),
  ('a0000000-0000-0000-0000-000000000004', 'data-pipeline', 'post_call', 'gpt-4o',             4000, 3000, 7000, 3500, false, NOW() - INTERVAL '10 days' + INTERVAL '40 minutes'),
  ('a0000000-0000-0000-0000-000000000005', 'code-review',   'post_call', 'claude-sonnet-4-6',  1500, 1100, 2600, 1400, false, NOW() - INTERVAL '9 days' + INTERVAL '10 minutes'),
  ('a0000000-0000-0000-0000-000000000005', 'code-review',   'post_call', 'claude-sonnet-4-6',  1200, 1800, 3000, 1900, false, NOW() - INTERVAL '9 days' + INTERVAL '20 minutes'),
  ('a0000000-0000-0000-0000-000000000006', 'support-bot',   'post_call', 'claude-haiku-4-5-20251001', 600, 500, 1100, 450, false, NOW() - INTERVAL '8 days' + INTERVAL '5 minutes'),
  ('a0000000-0000-0000-0000-000000000006', 'support-bot',   'post_call', 'claude-haiku-4-5-20251001', 500, 500, 1000, 380, false, NOW() - INTERVAL '8 days' + INTERVAL '15 minutes'),
  ('a0000000-0000-0000-0000-000000000007', 'data-pipeline', 'post_call', 'gpt-4o',             2500, 2300, 4800, 2400, false, NOW() - INTERVAL '7 days' + INTERVAL '10 minutes'),
  ('a0000000-0000-0000-0000-000000000007', 'data-pipeline', 'post_call', 'gpt-4o',             2800, 2200, 5000, 2600, false, NOW() - INTERVAL '7 days' + INTERVAL '30 minutes'),
  ('a0000000-0000-0000-0000-000000000008', 'code-review',   'post_call', 'claude-sonnet-4-6',  1800, 1500, 3300, 1600, false, NOW() - INTERVAL '6 days' + INTERVAL '10 minutes'),
  ('a0000000-0000-0000-0000-000000000008', 'code-review',   'post_call', 'claude-sonnet-4-6',  1400, 1600, 3000, 1700, false, NOW() - INTERVAL '6 days' + INTERVAL '25 minutes'),
  ('a0000000-0000-0000-0000-000000000009', 'support-bot',   'post_call', 'claude-sonnet-4-6',  1800, 2100, 3900, 2500, false, NOW() - INTERVAL '5 days' + INTERVAL '15 minutes'),
  ('a0000000-0000-0000-0000-000000000009', 'support-bot',   'post_call', 'claude-sonnet-4-6',  1600, 1900, 3500, 2200, false, NOW() - INTERVAL '5 days' + INTERVAL '35 minutes'),
  ('a0000000-0000-0000-0000-000000000010', 'data-pipeline', 'post_call', 'o3-mini',            4000, 3200, 7200, 4100, false, NOW() - INTERVAL '4 days' + INTERVAL '20 minutes'),
  ('a0000000-0000-0000-0000-000000000010', 'data-pipeline', 'post_call', 'o3-mini',            4500, 3500, 8000, 4500, false, NOW() - INTERVAL '4 days' + INTERVAL '40 minutes'),
  ('a0000000-0000-0000-0000-000000000011', 'code-review',   'post_call', 'claude-sonnet-4-6',  1000, 800, 1800, 1000, false, NOW() - INTERVAL '3 days' + INTERVAL '5 minutes'),
  ('a0000000-0000-0000-0000-000000000011', 'code-review',   'post_call', 'claude-sonnet-4-6',  900, 1100, 2000, 1300, false, NOW() - INTERVAL '3 days' + INTERVAL '15 minutes'),
  ('a0000000-0000-0000-0000-000000000012', 'support-bot',   'post_call', 'claude-haiku-4-5-20251001', 1200, 1000, 2200, 520, false, NOW() - INTERVAL '2 days' + INTERVAL '10 minutes'),
  ('a0000000-0000-0000-0000-000000000012', 'support-bot',   'post_call', 'claude-haiku-4-5-20251001', 1100, 1200, 2300, 580, false, NOW() - INTERVAL '2 days' + INTERVAL '20 minutes'),
  ('a0000000-0000-0000-0000-000000000013', 'code-review',   'post_call', 'gpt-4o',             1400, 1200, 2600, 1050, false, NOW() - INTERVAL '1 day' + INTERVAL '10 minutes'),
  ('a0000000-0000-0000-0000-000000000013', 'code-review',   'post_call', 'gpt-4o',             1100, 1400, 2500, 1200, false, NOW() - INTERVAL '1 day' + INTERVAL '30 minutes'),
  ('a0000000-0000-0000-0000-000000000014', 'data-pipeline', 'post_call', 'gpt-4o',             800, 600, 1400, 950,  false, NOW() - INTERVAL '1 hour'),
  ('a0000000-0000-0000-0000-000000000014', 'data-pipeline', 'tool_call','gpt-4o',             200, 200, 400,  300,  false, NOW() - INTERVAL '30 minutes')
ON CONFLICT DO NOTHING;
