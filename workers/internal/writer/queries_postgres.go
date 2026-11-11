package writer

// The Postgres query set: the statements that use jsonb operators,
// row locks, data-modifying CTEs or xmax, which SQLite spells
// differently (queries_sqlite.go). {{now}} is the dialect's current
// time, filled in by newQueries.

// upsertSessionPostgresSQL is the session_start upsert UpsertSession
// runs. It ends at the ON CONFLICT DO UPDATE's SET list; the claim and
// refresh statements complete it with the WHERE clause that splits an
// existing row by ownership, and their RETURNING lists.
const upsertSessionPostgresSQL = `
	INSERT INTO sessions (
		session_id, flavor, agent_type, host, framework, model, state,
		started_at, last_seen_at, context, token_id, token_name,
		agent_id, client_type, agent_name,
		parent_session_id, agent_role, capture_prompts,
		start_seq
	)
	VALUES (
		$1::uuid, $2, $3, NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7,
		-- An assembled OpenTelemetry session is dated by its start,
		-- capped at the database's clock; every other by the clock.
		CASE WHEN $8::jsonb ? 'otel_trace_id'
		     THEN LEAST({{now}}, COALESCE($18::timestamptz, {{now}}))
		     ELSE {{now}} END,
		{{now}}, $8::jsonb,
		NULLIF($9, '')::uuid, NULLIF($10, ''),
		$11::uuid, $12, $13,
		NULLIF($14, '')::uuid, NULLIF($15, ''), $16,
		NULLIF($17::bigint, 0)
	)
	ON CONFLICT (session_id) DO UPDATE
	SET -- A closed row is revived for a re-attachment, but stays closed
	    -- when the session_end that closed it was published after
	    -- this session_start: the worker pool handles a session's
	    -- events concurrently, so an end can be processed before
	    -- its own start. An unknown sequence (NULL on either side)
	    -- revives, which is the plain state rule.
	    state = CASE WHEN sessions.state = 'closed'
	                  AND sessions.closed_seq > NULLIF($17::bigint, 0)
	                 THEN sessions.state
	                 ELSE EXCLUDED.state END,
	    ended_at = CASE WHEN sessions.state = 'closed'
	                     AND sessions.closed_seq > NULLIF($17::bigint, 0)
	                    THEN sessions.ended_at
	                    ELSE NULL END,
	    closed_seq = CASE WHEN sessions.state = 'closed'
	                       AND sessions.closed_seq > NULLIF($17::bigint, 0)
	                      THEN sessions.closed_seq
	                      ELSE NULL END,
	    start_seq = GREATEST(sessions.start_seq, NULLIF($17::bigint, 0)),
	    -- An assembled session's start replaces the placeholder
	    -- started_at of a row its session has never started (a parent
	    -- stub or a lazily created row: no session_start has written
	    -- its capture posture yet). A re-attachment, and every other
	    -- client's start, keeps the stored value.
	    started_at = CASE WHEN sessions.capture_prompts IS NULL
	                       AND EXCLUDED.context ? 'otel_trace_id'
	                      THEN EXCLUDED.started_at
	                      ELSE sessions.started_at END,
	    last_seen_at = {{now}},
	    host = COALESCE(EXCLUDED.host, sessions.host),
	    framework = COALESCE(EXCLUDED.framework, sessions.framework),
	    model = COALESCE(EXCLUDED.model, sessions.model),
	    -- COALESCE the write-once columns so a lazily-created
	    -- row with NULL context / token columns picks up the real
	    -- values when session_start later arrives. Real values are
	    -- preserved (COALESCE returns the stored side first).
	    --
	    -- A sensor call that reached the worker before its
	    -- session_start filled sessions.framework on the lazy row
	    -- (UpdateSessionFromCall) but could not append to its NULL
	    -- context; when this start writes that context, it appends the
	    -- label unless an entry already has it, so a run with that one
	    -- call is not left out of the analytics framework dimension.
	    -- Other clients carry their own frameworks entries (or, for an
	    -- OpenTelemetry Claude Code session, none on purpose).
	    context = CASE
	        WHEN sessions.context IS NULL
	             AND sessions.framework IS NOT NULL
	             AND COALESCE(sessions.client_type, EXCLUDED.client_type) = 'flightdeck_sensor'
	             AND EXCLUDED.context IS NOT NULL AND EXCLUDED.context <> '{}'::jsonb
	             AND COALESCE(jsonb_typeof(EXCLUDED.context->'frameworks'), 'array') = 'array'
	             AND NOT EXISTS (
	                 SELECT 1
	                 FROM jsonb_array_elements_text(
	                     COALESCE(EXCLUDED.context->'frameworks', '[]'::jsonb)) AS f
	                 WHERE split_part(f, '/', 1) = sessions.framework
	             )
	        THEN jsonb_set(EXCLUDED.context, '{frameworks}',
	                       COALESCE(EXCLUDED.context->'frameworks', '[]'::jsonb)
	                       || to_jsonb(sessions.framework))
	        ELSE COALESCE(sessions.context, EXCLUDED.context) END,
	    token_id = COALESCE(sessions.token_id, EXCLUDED.token_id),
	    token_name = COALESCE(sessions.token_name, EXCLUDED.token_name),
	    -- Sentinel upgrade: "unknown" on flavor / agent_type
	    -- means "we lazy-created without authoritative data".
	    -- Replace it when a real session_start brings the truth.
	    flavor = CASE WHEN sessions.flavor = 'unknown'
	                  THEN EXCLUDED.flavor
	                  ELSE sessions.flavor END,
	    agent_type = CASE WHEN sessions.agent_type = 'unknown'
	                      THEN EXCLUDED.agent_type
	                      ELSE sessions.agent_type END,
	    -- Identity is write-once once non-null. A parent stub
	    -- writes NULL for agent_id / client_type / agent_name; the
	    -- claim statement (WHERE sessions.agent_id IS NULL) fills
	    -- them in. Real values (non-null) are preserved by COALESCE.
	    agent_id = COALESCE(sessions.agent_id, EXCLUDED.agent_id),
	    client_type = COALESCE(sessions.client_type, EXCLUDED.client_type),
	    agent_name = COALESCE(sessions.agent_name, EXCLUDED.agent_name),
	    -- Sub-agent columns. Write-once on insert; preserved
	    -- on conflict so a child's session_start can't accidentally
	    -- rewrite the parent row's null parent_session_id /
	    -- agent_role. The lazy-create-parent-stub branch
	    -- (UpsertParentStub) writes NULL for both, and a later real
	    -- parent session_start preserves NULL via COALESCE because
	    -- the parent itself isn't a sub-agent.
	    parent_session_id = COALESCE(
	        sessions.parent_session_id, EXCLUDED.parent_session_id),
	    agent_role = COALESCE(sessions.agent_role, EXCLUDED.agent_role),
	    -- Capture posture is write-once: the first authoritative
	    -- session_start pins it, and no later session_start (forged
	    -- or otherwise) can flip an established session's posture.
	    -- COALESCE keeps the already-stored value when present.
	    capture_prompts = COALESCE(
	        sessions.capture_prompts, EXCLUDED.capture_prompts)
`

var postgresQueries = queries{
	// The claim inserts the row, or updates an existing row that no
	// agent owns yet. A returned row is attributed to this start's agent.
	upsertSessionClaim: upsertSessionPostgresSQL + `
	WHERE sessions.agent_id IS NULL
	RETURNING true`,

	// The refresh updates an existing row that an agent owns, or inserts
	// the row when it is gone. RETURNING reports the insert: xmax = 0
	// marks a row this statement inserted, while an ON CONFLICT update
	// leaves this transaction's id in xmax.
	upsertSessionRefresh: upsertSessionPostgresSQL + `
	WHERE sessions.agent_id IS NOT NULL
	RETURNING (xmax = 0)`,

	// NULLIF(context, '{}'::jsonb) treats both "no context yet"
	// sentinels, NULL and the empty object, as "enrich me".
	upgradeSessionContext: `
		UPDATE sessions
		SET context = COALESCE(NULLIF(context, '{}'::jsonb), $2::jsonb)
		WHERE session_id = $1::uuid`,

	appendMCPServer: `
		UPDATE sessions
		SET context = jsonb_set(
			COALESCE(context, '{}'::jsonb),
			'{mcp_servers}',
			COALESCE(context->'mcp_servers', '[]'::jsonb) || $2::jsonb
		)
		WHERE session_id = $1::uuid
		  AND NOT EXISTS (
			SELECT 1
			  FROM jsonb_array_elements(
				COALESCE(context->'mcp_servers', '[]'::jsonb)
			  ) AS s
			 WHERE s->>'name' = $3
			   AND COALESCE(s->>'server_url', '') = COALESCE($4, '')
		  )`,

	updateSessionFromCall: `
		UPDATE sessions
		SET model = COALESCE(NULLIF($2, ''), model),
		    framework = COALESCE(framework, NULLIF($3, '')),
		    context = CASE
		        WHEN $3 <> ''
		             AND (framework IS NULL
		                  OR (framework = $3 AND client_type = 'flightdeck_sensor'))
		             AND context IS NOT NULL AND context <> '{}'::jsonb
		             AND COALESCE(jsonb_typeof(context->'frameworks'), 'array') = 'array'
		             AND NOT EXISTS (
		                 SELECT 1
		                 FROM jsonb_array_elements_text(COALESCE(context->'frameworks', '[]'::jsonb)) AS f
		                 WHERE split_part(f, '/', 1) = $3
		             )
		        THEN jsonb_set(context, '{frameworks}',
		                       COALESCE(context->'frameworks', '[]'::jsonb) || to_jsonb($3::text))
		        ELSE context END
		WHERE session_id = $1::uuid
		  AND ($2 <> '' OR (framework IS NULL AND $3 <> ''))`,

	// The row's prior state is read under the row lock the CTE takes;
	// the CASE in the SET clause revives a stale or lost row and only
	// advances last_seen_at otherwise (closed rows are excluded by the
	// WHERE clause). No row means the parent is closed or missing.
	bumpParent: `
		WITH prev AS (
			SELECT state FROM sessions
			WHERE session_id = $1::uuid AND state <> 'closed'
			FOR UPDATE
		),
		upd AS (
			UPDATE sessions
			SET state = CASE
			        WHEN state IN ('stale', 'lost') THEN 'active'
			        ELSE state
			    END,
			    last_seen_at = {{now}}
			WHERE session_id = $1::uuid AND state <> 'closed'
			RETURNING 1
		)
		SELECT COALESCE((SELECT state FROM prev), '')`,

	// The row's state before the write, read under the row lock the
	// prior CTE takes, says whether this call closed it.
	settleSessionEnd: `
		WITH prior AS (
			SELECT session_id, state FROM sessions
			WHERE session_id = $1::uuid
			FOR UPDATE
		)
		UPDATE sessions s
		SET state = 'closed',
		    ended_at = CASE WHEN s.state = 'closed' THEN s.ended_at
		                    WHEN COALESCE(s.context ? 'otel_trace_id', false)
		                    THEN LEAST({{now}}, COALESCE($3::timestamptz, {{now}}))
		                    ELSE {{now}} END,
		    last_seen_at = CASE WHEN s.state = 'closed' THEN s.last_seen_at ELSE {{now}} END,
		    closed_seq = CASE WHEN s.state = 'closed'
		                      THEN GREATEST(s.closed_seq, NULLIF($2::bigint, 0))
		                      ELSE NULLIF($2::bigint, 0) END
		FROM prior
		WHERE s.session_id = prior.session_id
		  AND (s.start_seq IS NULL OR $2::bigint = 0 OR s.start_seq < $2::bigint)
		  AND (s.state <> 'closed' OR s.closed_seq IS NULL OR s.closed_seq < $2::bigint)
		RETURNING prior.state <> 'closed'`,

	// $1 is the cutoff in seconds (negative) and $2 the event type of
	// the synthetic session_end. FOR UPDATE SKIP LOCKED lets two
	// reconciler instances reap disjoint subsets.
	reapOrphans: `
		WITH expired AS (
			SELECT session_id, flavor
			FROM sessions
			WHERE state = 'lost'
			  AND last_seen_at < ({{now}} + ($1) * INTERVAL '1 second')
			FOR UPDATE SKIP LOCKED
		),
		closed AS (
			UPDATE sessions s
			SET state = 'closed', ended_at = {{now}}
			FROM expired e
			WHERE s.session_id = e.session_id
			RETURNING s.session_id
		),
		inserted AS (
			INSERT INTO events (session_id, flavor, event_type, payload)
			SELECT e.session_id, e.flavor, $2::text,
			       jsonb_build_object('close_reason', 'orphan_timeout')
			FROM expired e
			RETURNING session_id, id
		)
		SELECT c.session_id::text, COALESCE(i.id::text, '')
		FROM closed c
		LEFT JOIN inserted i ON i.session_id = c.session_id`,

	// Batches are claimed with FOR UPDATE SKIP LOCKED, so several
	// workers share the work.
	backfillSelect: `
		SELECT e.id::text, e.occurred_at, e.session_id::text, e.model, e.event_type,
		       COALESCE(s.client_type, '')
		FROM events e
		LEFT JOIN sessions s ON s.session_id = e.session_id
		WHERE e.model IS NOT NULL AND e.model_requested IS NULL
		ORDER BY e.occurred_at
		LIMIT $1
		FOR UPDATE OF e SKIP LOCKED`,
}
