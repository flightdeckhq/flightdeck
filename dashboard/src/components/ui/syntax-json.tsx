export function SyntaxJson({ data }: { data: Record<string, unknown> }) {
  const json = JSON.stringify(data, null, 2);
  const colored = json.replace(
    /("(?:\\.|[^"\\])*")\s*:/g,
    (_, key) => `<span style="color:var(--event-llm)">${key}</span>:`
  ).replace(
    /:\s*("(?:\\.|[^"\\])*")/g,
    (match, val) => match.replace(val, `<span style="color:var(--status-active)">${val}</span>`)
  ).replace(
    /:\s*(\d+(?:\.\d+)?)/g,
    (match, num) => match.replace(num, `<span style="color:var(--event-warn)">${num}</span>`)
  ).replace(
    /:\s*(true|false|null)/g,
    (match, val) => match.replace(val, `<span style="color:var(--text-muted)">${val}</span>`)
  );

  return (
    <pre
      className="overflow-x-auto whitespace-pre font-mono text-[11px] leading-relaxed"
      style={{ color: "var(--text-secondary)" }}
      dangerouslySetInnerHTML={{ __html: colored }}
    />
  );
}
