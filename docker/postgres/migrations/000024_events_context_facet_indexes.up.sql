-- Runtime-context event facets (D157 Phase 5 / C1).
--
-- The /v1/events page gains 9 new facet + filter dimensions sourced
-- from sessions.context: os, arch, hostname, user, git_branch,
-- git_repo, orchestration, python_version, process_name. Each
-- facet's GROUP BY and filter predicate evaluates a
-- (context->>'<key>')-equality expression over the filtered event
-- set joined to sessions. A ->>-equality predicate is NOT served
-- by a GIN index, so each dimension needs a partial expression
-- index keyed on the extracted text.
--
-- The partial predicate ``(<expr>) IS NOT NULL`` keeps each index
-- tiny: only sessions that actually carry the key are indexed. The
-- filter predicate applies ``(<expr>) = ANY(...)``, a strict
-- predicate the planner proves implies ``(<expr>) IS NOT NULL``,
-- so the partial index stays usable for both the row query and the
-- facet-count GROUP BY. Mirrors 000023's pattern on the events
-- table's payload->> facets.

CREATE INDEX IF NOT EXISTS sessions_context_os_idx
    ON sessions ((context->>'os'))
    WHERE (context->>'os') IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_context_arch_idx
    ON sessions ((context->>'arch'))
    WHERE (context->>'arch') IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_context_hostname_idx
    ON sessions ((context->>'hostname'))
    WHERE (context->>'hostname') IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_context_user_idx
    ON sessions ((context->>'user'))
    WHERE (context->>'user') IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_context_git_branch_idx
    ON sessions ((context->>'git_branch'))
    WHERE (context->>'git_branch') IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_context_git_repo_idx
    ON sessions ((context->>'git_repo'))
    WHERE (context->>'git_repo') IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_context_orchestration_idx
    ON sessions ((context->>'orchestration'))
    WHERE (context->>'orchestration') IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_context_python_version_idx
    ON sessions ((context->>'python_version'))
    WHERE (context->>'python_version') IS NOT NULL;

CREATE INDEX IF NOT EXISTS sessions_context_process_name_idx
    ON sessions ((context->>'process_name'))
    WHERE (context->>'process_name') IS NOT NULL;
