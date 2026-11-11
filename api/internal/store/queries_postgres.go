package store

import "github.com/flightdeckhq/flightdeck/storage"

// queries holds the SQL fragments that differ between the two backends
// beyond what storage.Dialect renders. Each backend has one
// implementation (this file and queries_sqlite.go); the Store picks it
// by storage.DB.Backend. Shared SQL stays in the store files and
// composes these fragments.
type queries interface {
	// jsonArrayAgg aggregates the text expression expr of a subquery's
	// rows into a JSON array of strings, '[]' for no rows. Scanned
	// through jsonStrings.
	jsonArrayAgg(expr string) string
	// forUpdate is the row-lock clause of a SELECT that a transaction
	// will update: FOR UPDATE on Postgres; nothing on SQLite, where
	// the writer's IMMEDIATE transaction already holds the lock.
	forUpdate() string
	// priceJoin joins each LLM event aliased e to its model_pricing row
	// as mp (see CostPriceJoinSQL), or no row.
	priceJoin() string
	// frameworkLabels is the FROM fragment that yields, for the
	// sessions row aliased s, one row per distinct framework label of
	// s.context.frameworks (the part before the "/"), with the label in
	// frameworkLabelExpr; a session with no frameworks yields one row
	// with a NULL label.
	frameworkLabels() string
	// frameworkLabelExpr is the label column frameworkLabels defines.
	frameworkLabelExpr() string
	// contextFacets is the query behind GetContextFacets: (key, value,
	// count) over every session's context, arrays unnested element by
	// element.
	contextFacets() string
	// auditLogTieBreak orders audit-log rows that share an occurred_at,
	// newest first. A policy change writes its rows within one
	// millisecond, and the row id is a random UUID, so the timestamp
	// alone does not order them.
	auditLogTieBreak() string
}

func queriesFor(b storage.Backend) queries {
	if b == storage.SQLite {
		return sqliteQueries{}
	}
	return postgresQueries{}
}

type postgresQueries struct{}

func (postgresQueries) jsonArrayAgg(expr string) string {
	return "COALESCE(json_agg(" + expr + "), '[]'::json)::text"
}

func (postgresQueries) forUpdate() string { return " FOR UPDATE" }

// priceJoin: the exact id before the undated id, the platform family's
// row before the direct one. The LATERAL evaluates per event.
func (postgresQueries) priceJoin() string {
	return `LEFT JOIN LATERAL (
		SELECT p.* FROM model_pricing p
		WHERE ` + costEventFilter + `
		  AND p.model_id IN (e.model, ` + undatedModelSQL + `)
		  AND p.platform IN (` + platformFamilySQL + `, 'direct')
		ORDER BY (p.model_id = e.model) DESC, (p.platform = 'direct') ASC
		LIMIT 1
	) mp ON TRUE`
}

// frameworkLabels unnests the array in a LATERAL subquery that
// de-duplicates labels per session, so a session tagged with two
// versions of one framework counts once under it.
func (postgresQueries) frameworkLabels() string {
	return `LEFT JOIN LATERAL (
		SELECT DISTINCT NULLIF(split_part(entry, '/', 1), '') AS fw
		FROM jsonb_array_elements_text(
			CASE WHEN jsonb_typeof(s.context->'frameworks') = 'array'
			     THEN s.context->'frameworks' ELSE '[]'::jsonb END
		) AS entry
	) AS framework_labels ON TRUE`
}

func (postgresQueries) frameworkLabelExpr() string { return "framework_labels.fw" }

// auditLogTieBreak: occurred_at defaults to now(), the transaction's
// start at microsecond precision, so two changes never share it; rows
// of one change do, and the id keeps their order stable between reads.
func (postgresQueries) auditLogTieBreak() string { return "a.id DESC" }

// contextFacets: scalar values take the #>> '{}' branch (text of the
// scalar), array values the jsonb_array_elements_text branch (one row
// per element). The jsonb_typeof guards make the branches exclusive.
func (postgresQueries) contextFacets() string {
	return `
		WITH context_pairs AS (
			SELECT key, value
			FROM sessions, jsonb_each(context)
			WHERE context IS NOT NULL
		)
		SELECT key, val AS value, COUNT(*) AS count
		FROM context_pairs,
		     LATERAL (
		         SELECT jsonb_array_elements_text(value) AS val
		         WHERE jsonb_typeof(value) = 'array'
		         UNION ALL
		         SELECT value #>> '{}' AS val
		         WHERE jsonb_typeof(value) <> 'array'
		     ) expanded
		WHERE val IS NOT NULL
		GROUP BY key, val
		ORDER BY key ASC, count DESC, val ASC`
}
