/**
 * Runtime context types for the dashboard CONTEXT sidebar facet
 * panel and the session drawer RUNTIME panel.
 *
 * The sensor collects this dict at init() time
 * (sensor/flightdeck_sensor/core/context.py) and the control plane
 * stores it once per session in sessions.context (JSONB). The fleet
 * API aggregates it across all non-terminal sessions into facets.
 */

/** A single (value, count) entry inside a facet group. */
export interface ContextFacetValue {
  value: string;
  count: number;
}

/**
 * Map of context key -> sorted list of distinct values with counts.
 * Returned by GET /v1/fleet under the `context_facets` field.
 *
 * Example:
 *   {
 *     "git_branch": [
 *       { "value": "main",        "count": 12 },
 *       { "value": "feat/payment", "count":  3 }
 *     ],
 *     "k8s_namespace": [
 *       { "value": "production", "count": 10 },
 *       { "value": "staging",    "count":  5 }
 *     ]
 *   }
 */
export type ContextFacets = Record<string, ContextFacetValue[]>;

/**
 * Active filter selections from the CONTEXT sidebar. A session
 * matches when, for every key in the filters object, the session's
 * context value for that key is in the selected values list.
 *
 * Empty object = no filters active = all sessions match.
 */
export type ContextFilters = Record<string, string[]>;
