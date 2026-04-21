package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// EventsParams defines filters for bulk event queries.
//
// Before and Order power the drawer's "Show older events" pagination.
// Before is a keyset cursor: when non-zero, only rows with
// occurred_at < Before are returned. Order selects the sort direction
// ("asc" or "desc"); any other value (including empty) falls back to
// ASC for backwards compatibility with existing callers that rely on
// chronological order.
type EventsParams struct {
	From      time.Time
	To        time.Time
	Flavor    string
	EventType string
	SessionID string
	Before    time.Time
	Order     string
	Limit     int
	Offset    int
}

// EventsResponse is the paginated response for GET /v1/events.
type EventsResponse struct {
	Events  []Event `json:"events"`
	Total   int     `json:"total"`
	Limit   int     `json:"limit"`
	Offset  int     `json:"offset"`
	HasMore bool    `json:"has_more"`
}

// GetEvents returns events matching the given filters with pagination.
//
// The COUNT(*) and the data SELECT run inside a single read-only
// REPEATABLE READ transaction so the returned `total` and `events`
// are consistent with the same snapshot. Concurrent inserts cannot
// produce a state where len(events) > total or has_more lies.
//
// HasMore is computed from `Offset + Limit <= total` rather than from
// `Offset + len(events) < total` so the semantics do not depend on
// len(events) equalling Limit at every page boundary. Inside the
// repeatable-read snapshot Total is fixed, so the comparison is exact.
func (s *Store) GetEvents(ctx context.Context, params EventsParams) (*EventsResponse, error) {
	var conditions []string
	var args []interface{}
	argIdx := 1

	conditions = append(conditions, fmt.Sprintf("occurred_at >= $%d", argIdx))
	args = append(args, params.From)
	argIdx++

	conditions = append(conditions, fmt.Sprintf("occurred_at <= $%d", argIdx))
	args = append(args, params.To)
	argIdx++

	if params.Flavor != "" {
		conditions = append(conditions, fmt.Sprintf("flavor = $%d", argIdx))
		args = append(args, params.Flavor)
		argIdx++
	}
	if params.EventType != "" {
		conditions = append(conditions, fmt.Sprintf("event_type = $%d", argIdx))
		args = append(args, params.EventType)
		argIdx++
	}
	if params.SessionID != "" {
		conditions = append(conditions, fmt.Sprintf("session_id = $%d::uuid", argIdx))
		args = append(args, params.SessionID)
		argIdx++
	}
	if !params.Before.IsZero() {
		conditions = append(conditions, fmt.Sprintf("occurred_at < $%d", argIdx))
		args = append(args, params.Before)
		argIdx++
	}

	// Default ASC preserves pre-pagination callers (bulk history loader,
	// Fleet historical events). Only ``desc`` flips the order.
	orderDir := "ASC"
	if strings.EqualFold(params.Order, "desc") {
		orderDir = "DESC"
	}

	where := "WHERE " + strings.Join(conditions, " AND ")

	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, fmt.Errorf("begin tx: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	// Count total
	countSQL := fmt.Sprintf("SELECT COUNT(*) FROM events %s", where)
	var total int
	if err := tx.QueryRow(ctx, countSQL, args...).Scan(&total); err != nil {
		return nil, fmt.Errorf("count events: %w", err)
	}

	// Fetch page
	querySQL := fmt.Sprintf(`
		SELECT id::text, session_id::text, flavor, event_type, model,
		       tokens_input, tokens_output, tokens_total,
		       tokens_cache_read, tokens_cache_creation,
		       latency_ms, tool_name, has_content, payload, occurred_at
		FROM events
		%s
		ORDER BY occurred_at %s
		LIMIT $%d OFFSET $%d
	`, where, orderDir, argIdx, argIdx+1)
	args = append(args, params.Limit, params.Offset)

	rows, err := tx.Query(ctx, querySQL, args...)
	if err != nil {
		return nil, fmt.Errorf("get events: %w", err)
	}
	defer rows.Close()

	var events []Event
	for rows.Next() {
		var e Event
		var payloadRaw []byte
		if err := rows.Scan(
			&e.ID, &e.SessionID, &e.Flavor, &e.EventType, &e.Model,
			&e.TokensInput, &e.TokensOutput, &e.TokensTotal,
			&e.TokensCacheRead, &e.TokensCacheCreation,
			&e.LatencyMs, &e.ToolName, &e.HasContent, &payloadRaw, &e.OccurredAt,
		); err != nil {
			return nil, fmt.Errorf("scan event: %w", err)
		}
		if len(payloadRaw) > 0 {
			var v map[string]any
			if jsonErr := json.Unmarshal(payloadRaw, &v); jsonErr == nil && len(v) > 0 {
				e.Payload = v
			}
		}
		events = append(events, e)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("events scan: %w", err)
	}
	if events == nil {
		events = []Event{}
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit tx: %w", err)
	}

	return &EventsResponse{
		Events:  events,
		Total:   total,
		Limit:   params.Limit,
		Offset:  params.Offset,
		HasMore: params.Offset+params.Limit <= total,
	}, nil
}
