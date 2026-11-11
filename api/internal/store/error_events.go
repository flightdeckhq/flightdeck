package store

import "regexp"

// errorEventFilter matches the events that count as errors on every
// per-session and per-agent surface: an llm_error, and a tool_call
// whose payload carries an error object (a failed tool call, which the
// Claude Code plugin and the OTLP receiver store as a tool_call with
// the error block rather than as an event type of its own). A failed
// mcp_tool_call is left out: MCP failures carry the JSON-RPC taxonomy
// and have their own mcp_error_types aggregate. The events alias is
// `e`. The session listing's error_types aggregate and error_type
// filter and the agent summary's errors count all use this one
// predicate so they cannot drift apart.
func (s *Store) errorEventFilter() string {
	return "(e.event_type = 'llm_error' OR " +
		"(e.event_type = 'tool_call' AND " + s.d.JSONTypeOf("e.payload", "error") + " = 'object'))"
}

// mcpServerFacetExpr is the /v1/events mcp_server facet's value
// expression. Claude Code keys a server bundled with a plugin as
// `plugin:<plugin>:<server>`; plugin releases before v0.6.0 stored the
// flattened tool-name form `plugin_<plugin>_<server>` instead. The
// expression rebuilds the colon key from the flattened one exactly as
// the plugin does (the plugin name runs up to the first underscore and
// neither part is empty; the flattened form holds no colon), so one
// server is one facet value across the upgrade. Any other server name
// is returned unchanged. regexp_replace spells the same on both
// engines (Postgres 15+, and the function the storage driver gives
// SQLite).
func (s *Store) mcpServerFacetExpr() string {
	return `regexp_replace(` + s.d.JSONText("payload", "server_name") + `, ` +
		`'^plugin_([^_:]+)_([^:]+)$', 'plugin:\1:\2')`
}

// pluginServerKey matches a colon-form plugin server key and captures
// its plugin and server parts, the inverse of mcpServerFacetExpr.
var pluginServerKey = regexp.MustCompile(`^plugin:([^_:]+):([^:]+)$`)

// expandMCPServerFilter returns the server_name values a mcp_server
// filter matches: each requested value, plus the flattened spelling of
// a colon-form plugin key so rows stored before the plugin wrote the
// colon key match too. Matching the stored spellings (instead of
// filtering on mcpServerFacetExpr) keeps the filter on the
// server_name expression index.
func expandMCPServerFilter(values []string) []string {
	if len(values) == 0 {
		return values
	}
	out := make([]string, 0, len(values)*2)
	for _, v := range values {
		out = append(out, v)
		if m := pluginServerKey.FindStringSubmatch(v); m != nil {
			out = append(out, "plugin_"+m[1]+"_"+m[2])
		}
	}
	return out
}
