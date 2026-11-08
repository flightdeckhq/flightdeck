package store

type sqliteQueries struct{}

func (sqliteQueries) jsonArrayAgg(expr string) string {
	return "json_group_array(" + expr + ")"
}

func (sqliteQueries) forUpdate() string { return "" }

// priceJoin: SQLite has no LATERAL, so the row is chosen by a
// correlated subquery on its rowid, evaluated per event like the
// Postgres LATERAL; the same preference order picks the row.
func (sqliteQueries) priceJoin() string {
	return `LEFT JOIN model_pricing mp ON mp.rowid = (
		SELECT p.rowid FROM model_pricing p
		WHERE ` + costEventFilter + `
		  AND p.model_id IN (e.model, ` + undatedModelSQL + `)
		  AND p.platform IN (` + platformFamilySQL + `, 'direct')
		ORDER BY (p.model_id = e.model) DESC, (p.platform = 'direct') ASC
		LIMIT 1
	)`
}

// sqliteFrameworkLabel is the label of one frameworks entry (json_each
// alias fw): the text before the first "/", or the whole entry.
const sqliteFrameworkLabel = `NULLIF(CASE WHEN instr(fw.value, '/') > 0
	THEN substr(fw.value, 1, instr(fw.value, '/') - 1) ELSE fw.value END, '')`

// frameworkLabels: json_each over the array is a table-valued function
// that may reference the preceding sessions row; the ON clause keeps
// the first entry of each label so a session counts once per label, and
// keeps the NULL row json_each yields for an empty array.
func (sqliteQueries) frameworkLabels() string {
	arr := `(CASE WHEN json_type(s.context, '$.frameworks') = 'array'
		THEN json_extract(s.context, '$.frameworks') ELSE '[]' END)`
	return `LEFT JOIN json_each(` + arr + `) AS fw
		ON fw.key IS NULL OR NOT EXISTS (
			SELECT 1 FROM json_each(` + arr + `) AS f2
			WHERE f2.key < fw.key
			  AND ` + sqliteFrameworkLabelFor("f2") + ` IS ` + sqliteFrameworkLabel + `
		)`
}

// sqliteFrameworkLabelFor is sqliteFrameworkLabel over another alias.
func sqliteFrameworkLabelFor(alias string) string {
	return `NULLIF(CASE WHEN instr(` + alias + `.value, '/') > 0
	THEN substr(` + alias + `.value, 1, instr(` + alias + `.value, '/') - 1) ELSE ` + alias + `.value END, '')`
}

func (sqliteQueries) frameworkLabelExpr() string { return sqliteFrameworkLabel }

// contextFacets: json_each over each document gives key, value and
// type; array values are unnested with a second json_each. Booleans
// render as 'true' / 'false' (json_each gives 1 / 0), the text Postgres'
// #>> yields.
func (sqliteQueries) contextFacets() string {
	return `
		WITH context_pairs AS (
			SELECT kv.key AS key, kv.value AS value, kv.type AS type
			FROM sessions, json_each(sessions.context) AS kv
			WHERE sessions.context IS NOT NULL
		),
		expanded AS (
			SELECT cp.key AS key, el.value AS val
			FROM context_pairs cp, json_each(cp.value) AS el
			WHERE cp.type = 'array'
			UNION ALL
			SELECT cp.key AS key,
			       CASE cp.type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false'
			            ELSE CAST(cp.value AS TEXT) END AS val
			FROM context_pairs cp
			WHERE cp.type <> 'array'
		)
		SELECT key, val AS value, COUNT(*) AS count
		FROM expanded
		GROUP BY key, val
		ORDER BY key ASC, count DESC, val ASC`
}
