-- Inverse of 000024_events_context_facet_indexes.up.sql.

DROP INDEX IF EXISTS sessions_context_os_idx;
DROP INDEX IF EXISTS sessions_context_arch_idx;
DROP INDEX IF EXISTS sessions_context_hostname_idx;
DROP INDEX IF EXISTS sessions_context_user_idx;
DROP INDEX IF EXISTS sessions_context_git_branch_idx;
DROP INDEX IF EXISTS sessions_context_git_repo_idx;
DROP INDEX IF EXISTS sessions_context_orchestration_idx;
DROP INDEX IF EXISTS sessions_context_python_version_idx;
DROP INDEX IF EXISTS sessions_context_process_name_idx;
