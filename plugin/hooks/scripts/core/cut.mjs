// A value the plugin cuts, and the list that says so. A text value cut
// to a bound keeps its first characters and ends with CUT_MARK; the
// ``tool_use`` block of a cut tool input lists it in ``truncated``,
// beside ``input`` and never inside it, as RFC 6901 JSON Pointers
// relative to ``input`` (ARCHITECTURE.md, Plugin > Cut values in tool
// content).

// What ends a value that was cut, after the characters kept, so that a
// command cut mid-way does not read as the whole command.
export const CUT_MARK = "…";

/**
 * ``value`` within ``maxChars`` characters (code points, so a cut never
 * splits a surrogate pair): ``{text, cut}``, where a value over the
 * bound keeps its first ``maxChars`` characters followed by CUT_MARK
 * and ``cut`` is true. A value at or under the bound is returned whole.
 */
export function cutChars(value, maxChars) {
  const text = String(value);
  const chars = Array.from(text);
  if (chars.length <= maxChars) return { text, cut: false };
  return { text: chars.slice(0, maxChars).join("") + CUT_MARK, cut: true };
}

/**
 * The RFC 6901 JSON Pointer to the value reached by ``keys`` (object
 * keys or array indexes) from the block's data: ``["command"]`` is
 * ``/command``, and ``~`` and ``/`` in a key are escaped as ``~0`` and
 * ``~1``.
 */
export function jsonPointer(keys) {
  return keys.map((key) => `/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

/**
 * ``block`` with ``truncated`` set to ``pointers`` (from jsonPointer)
 * when any value of it was cut; a block with nothing cut is returned
 * without the key.
 */
export function withTruncated(block, pointers) {
  return pointers.length > 0 ? { ...block, truncated: [...pointers] } : block;
}
