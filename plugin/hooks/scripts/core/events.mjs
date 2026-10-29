// Event alias tables. Every client names its lifecycle hooks its own
// way; a binding supplies a table mapping its hook names to Flightdeck
// event_type values, and its dispatcher looks each hook up through the
// table. A hook with no entry emits no event of its own (a binding may
// still handle it, as Claude Code's PreToolUse policy gate does).

/**
 * Wrap a binding's ``{hookName: event_type}`` map. ``eventTypeFor``
 * returns the mapped event_type, or undefined for a hook the table does
 * not name. The map is kept as given, not copied, so the binding can
 * export the same object.
 */
export function createEventAliasTable(aliases) {
  return {
    aliases,
    eventTypeFor(hookName) {
      return aliases[hookName];
    },
  };
}
