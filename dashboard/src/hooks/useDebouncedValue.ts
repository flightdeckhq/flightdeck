import { useEffect, useState } from "react";

/**
 * Returns ``value`` after it has been stable for ``delay``
 * milliseconds. Used by the MCP Protection Policy entry-editor
 * dialog to throttle ``GET /v1/mcp-policies/resolve`` calls while
 * the operator is still typing the server URL / name (D135 §
 * "Add / edit dialog" — 300ms debounce).
 *
 * The hook resets the timer on every value change. While the
 * timer is in flight the previously-stable value is returned, so
 * a downstream effect that fires off the debounced value runs
 * exactly once per stable input.
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(handle);
  }, [value, delay]);

  return debounced;
}
