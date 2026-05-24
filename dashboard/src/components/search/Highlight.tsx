/**
 * Case-insensitive substring highlighter. Renders ``text`` with
 * every match of ``query`` wrapped in a bold ``<mark>``. Match is
 * literal — query string is regex-escaped so a paste of e.g.
 * ``post_call`` matches the literal underscore rather than the
 * single-char wildcard.
 *
 * Returns the original text unmodified when ``query`` is empty or
 * shorter than the search hook's minimum (kept inline; callers
 * already gate on that floor).
 */
interface HighlightProps {
  text: string;
  query: string;
  className?: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function Highlight({ text, query, className }: HighlightProps) {
  if (!text) return null;
  if (!query) return <span className={className}>{text}</span>;
  const trimmed = query.trim();
  if (!trimmed) return <span className={className}>{text}</span>;
  const re = new RegExp(`(${escapeRegExp(trimmed)})`, "ig");
  const parts = text.split(re);
  return (
    <span className={className}>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark
            key={i}
            className="bg-transparent font-semibold text-text"
            data-testid="highlight-match"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </span>
  );
}
