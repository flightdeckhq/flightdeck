// A value the plugin cuts, and the list that says so. A text value cut
// to a bound keeps its first characters and ends with CUT_MARK; the
// content block that holds it lists it in ``truncated``, beside the
// value and never inside it, as RFC 6901 JSON Pointers: a ``tool_use``
// block relative to its ``input``, a ``tool_result`` block relative to
// its parsed ``content`` (ARCHITECTURE.md, Plugin > Cut values in tool
// content). Lengths count characters (code points), so a cut never
// splits a surrogate pair.

// What ends a value that was cut, after the characters kept, so that a
// command cut mid-way does not read as the whole command.
export const CUT_MARK = "…";

/** Whether the UTF-16 unit at ``i`` of ``s`` starts a surrogate pair. */
function startsPair(s, i) {
  const unit = s.charCodeAt(i);
  return unit >= 0xd800 && unit <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
}

/**
 * The first ``n`` characters (code points) of ``s``, and whether ``s``
 * has more. Reads at most ``n`` characters, however long ``s`` is.
 */
export function headChars(s, n) {
  let i = 0;
  let count = 0;
  while (i < s.length && count < n) {
    i += startsPair(s, i) ? 2 : 1;
    count += 1;
  }
  return { head: s.slice(0, i), more: i < s.length };
}

/** The number of characters (code points) of ``s``. */
export function charCount(s) {
  let count = 0;
  for (let i = 0; i < s.length; i += startsPair(s, i) ? 2 : 1) count += 1;
  return count;
}

/**
 * ``value`` within ``maxChars`` characters: ``{text, cut}``, where a
 * value over the bound keeps its first ``maxChars`` characters followed
 * by CUT_MARK and ``cut`` is true. A value at or under the bound is
 * returned whole.
 */
export function cutChars(value, maxChars) {
  const text = String(value);
  const { head, more } = headChars(text, maxChars);
  return more ? { text: head + CUT_MARK, cut: true } : { text, cut: false };
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
