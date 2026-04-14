package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// SessionsParams defines filters for paginated session queries.
type SessionsParams struct {
	From    time.Time
	To      time.Time
	Query   string   // Full-text search (ILIKE across multiple fields)
	States  []string // active, idle, stale, closed, lost
	Flavors []string
	Model   string
	Sort    string // started_at, duration, tokens_used, flavor
	Order   string // asc, desc
	Limit   int
	Offset  int
}

// SessionListItem is one row in the paginated sessions response.
// It includes the full context JSONB so the frontend can extract
// os, hostname, orchestration, git_branch, frameworks without a
// second round-trip.
type SessionListItem struct {
	SessionID      string                 `json:"session_id"`
	Flavor         string                 `json:"flavor"`
	Host           *string                `json:"host"`
	Model          *string                `json:"model"`
	State          string                 `json:"state"`
	StartedAt      time.Time              `json:"started_at"`
	EndedAt        *time.Time             `json:"ended_at"`
	DurationS      float64                `json:"duration_s"`
	TokensUsed     int                    `json:"tokens_used"`
	TokenLimit     *int64                 `json:"token_limit"`
	Context        map[string]interface{} `json:"context"`
	CaptureEnabled bool                   `json:"capture_enabled"`
	// D095: attribution for the api_tokens row that opened this
	// session. TokenID is nullable because revocation clears the FK
	// (ON DELETE SET NULL); TokenName is preserved for auditability
	// so the UI can still render "Created via: Staging K8s (revoked)"
	// long after the token row is gone.
	TokenID   *string `json:"token_id"`
	TokenName *string `json:"token_name"`
}

// SessionsResponse is the paginated response for GET /v1/sessions.
type SessionsResponse struct {
	Sessions []SessionListItem `json:"sessions"`
	Total    int               `json:"total"`
	Limit    int               `json:"limit"`
	Offset   int               `json:"offset"`
	HasMore  bool              `json:"has_more"`
}

// allowedSorts prevents SQL injection in the ORDER BY clause.
var allowedSorts = map[string]string{
	"started_at": "s.started_at",
	"duration":   "EXTRACT(EPOCH FROM (COALESCE(s.ended_at, NOW()) - s.started_at))",
	"tokens_used": "s.tokens_used",
	"flavor":     "s.flavor",
}

// GetSessions returns sessions matching the given filters with pagination.
//
// Follows the same pattern as GetEvents: REPEATABLE READ transaction
// wrapping a COUNT(*) and a data SELECT so total and rows are
// consistent within one snapshot.
func (s *Store) GetSessions(ctx context.Context, params SessionsParams) (*SessionsResponse, error) {
	var conditions []string
	var args []interface{}
	argIdx := 1

	// Time range on started_at
	conditions = append(conditions, fmt.Sprintf("s.started_at >= $%d", argIdx))
	args = append(args, params.From)
	argIdx++

	conditions = append(conditions, fmt.Sprintf("s.started_at <= $%d", argIdx))
	args = append(args, params.To)
	argIdx++

	// State filter (repeatable: OR within group)
	if len(params.States) > 0 {
		placeholders := make([]string, len(params.States))
		for i, st := range params.States {
			placeholders[i] = fmt.Sprintf("$%d", argIdx)
			args = append(args, st)
			argIdx++
		}
		conditions = append(conditions, fmt.Sprintf("s.state IN (%s)", strings.Join(placeholders, ", ")))
	}

	// Flavor filter (repeatable: OR within group)
	if len(params.Flavors) > 0 {
		placeholders := make([]string, len(params.Flavors))
		for i, fl := range params.Flavors {
			placeholders[i] = fmt.Sprintf("$%d", argIdx)
			args = append(args, fl)
			argIdx++
		}
		conditions = append(conditions, fmt.Sprintf("s.flavor IN (%s)", strings.Join(placeholders, ", ")))
	}

	// Model filter
	if params.Model != "" {
		conditions = append(conditions, fmt.Sprintf("s.model = $%d", argIdx))
		args = append(args, params.Model)
		argIdx++
	}

	// Full-text search across multiple fields
	if params.Query != "" {
		pattern := sanitizeQuery(params.Query)
		qPlaceholder := fmt.Sprintf("$%d", argIdx)
		args = append(args, pattern)
		argIdx++
		conditions = append(conditions, fmt.Sprintf(`(
			s.flavor ILIKE %[1]s
			OR COALESCE(s.host, '') ILIKE %[1]s
			OR COALESCE(s.model, '') ILIKE %[1]s
			OR s.session_id::text ILIKE %[1]s
			OR COALESCE(s.context->>'hostname', '') ILIKE %[1]s
			OR COALESCE(s.context->>'os', '') ILIKE %[1]s
			OR COALESCE(s.context->>'git_branch', '') ILIKE %[1]s
			OR COALESCE(s.context->>'python_version', '') ILIKE %[1]s
			OR COALESCE((s.context->'frameworks')::text, '') ILIKE %[1]s
		)`, qPlaceholder))
	}

	where := "WHERE " + strings.Join(conditions, " AND ")

	// Resolve sort column (validated by handler; fallback defensively)
	sortExpr, ok := allowedSorts[params.Sort]
	if !ok {
		sortExpr = "s.started_at"
	}
	orderDir := "DESC"
	if strings.EqualFold(params.Order, "asc") {
		orderDir = "ASC"
	}

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Count total
	countSQL := fmt.Sprintf("SELECT COUNT(*) FROM sessions s %s", where)
	var total int
	if err := tx.QueryRow(ctx, countSQL, args...).Scan(&total); err != nil {
		return nil, fmt.Errorf("count sessions: %w", err)
	}

	// Fetch page
	querySQL := fmt.Sprintf(`
		SELECT
			s.session_id::text,
			s.flavor,
			s.host,
			s.model,
			s.state,
			s.started_at,
			s.ended_at,
			EXTRACT(EPOCH FROM (COALESCE(s.ended_at, NOW()) - s.started_at)) AS duration_s,
			s.tokens_used,
			s.token_limit,
			s.context,
			EXISTS(
				SELECT 1 FROM events e
				WHERE e.session_id = s.session_id
				AND e.has_content = true
				LIMIT 1
			) AS capture_enabled,
			s.token_id::text,
			s.token_name
		FROM sessions s
		%s
		ORDER BY %s %s
		LIMIT $%d OFFSET $%d
	`, where, sortExpr, orderDir, argIdx, argIdx+1)
	args = append(args, params.Limit, params.Offset)

	rows, err := tx.Query(ctx, querySQL, args...)
	if err != nil {
		return nil, fmt.Errorf("get sessions: %w", err)
	}
	defer rows.Close()

	var sessions []SessionListItem
	for rows.Next() {
		var item SessionListItem
		var contextRaw []byte
		if err := rows.Scan(
			&item.SessionID,
			&item.Flavor,
			&item.Host,
			&item.Model,
			&item.State,
			&item.StartedAt,
			&item.EndedAt,
			&item.DurationS,
			&item.TokensUsed,
			&item.TokenLimit,
			&contextRaw,
			&item.CaptureEnabled,
			&item.TokenID,
			&item.TokenName,
		); err != nil {
			return nil, fmt.Errorf("scan session: %w", err)
		}
		if len(contextRaw) > 0 {
			var v map[string]interface{}
			if jsonErr := json.Unmarshal(contextRaw, &v); jsonErr == nil {
				item.Context = v
			}
		}
		if item.Context == nil {
			item.Context = map[string]interface{}{}
		}
		sessions = append(sessions, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sessions scan: %w", err)
	}
	if sessions == nil {
		sessions = []SessionListItem{}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	return &SessionsResponse{
		Sessions: sessions,
		Total:    total,
		Limit:    params.Limit,
		Offset:   params.Offset,
		HasMore:  params.Offset+params.Limit <= total,
	}, nil
}
