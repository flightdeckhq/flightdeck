/**
 * SyntaxJson renders a JSON value with key/string/number/boolean
 * coloring. The input data may originate from event payloads which
 * are not under our control, so the JSON-stringified output MUST be
 * HTML-escaped before any regex span-wrapping is applied. Otherwise
 * a string like `<script>` inside an event field would be rendered
 * as raw HTML.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function SyntaxJson({ data }: { data: Record<string, unknown> }) {
  // 1. JSON.stringify
  // 2. HTML-escape so any user-controlled `<`, `>`, `&` cannot break
  //    out of the <pre> via dangerouslySetInnerHTML
  // 3. Regex-wrap the *escaped* string with span tags. The regex now
  //    operates on the escaped form (`&quot;` instead of `"`), so the
  //    patterns must match the escaped quote.
  const escaped = escapeHtml(JSON.stringify(data, null, 2));

  const colored = escaped
    .replace(
      /(&quot;(?:\\.|[^&\\])*?&quot;)\s*:/g,
      (_, key) => `<span style="color:var(--event-llm)">${key}</span>:`,
    )
    .replace(
      /:\s*(&quot;(?:\\.|[^&\\])*?&quot;)/g,
      (match, val) => match.replace(val, `<span style="color:var(--status-active)">${val}</span>`),
    )
    .replace(
      /:\s*(\d+(?:\.\d+)?)/g,
      (match, num) => match.replace(num, `<span style="color:var(--event-warn)">${num}</span>`),
    )
    .replace(
      /:\s*(true|false|null)/g,
      (match, val) => match.replace(val, `<span style="color:var(--text-muted)">${val}</span>`),
    );

  return (
    <pre
      className="overflow-x-auto whitespace-pre font-mono text-[11px] leading-relaxed"
      style={{ color: "var(--text-secondary)" }}
      dangerouslySetInnerHTML={{ __html: colored }}
    />
  );
}
