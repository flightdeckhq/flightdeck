/**
 * Small pill rendering an event's bare-name `framework` attribution
 * (`langchain`, `crewai`, `langgraph`, `llama_index`, …).
 *
 * Frameworks are an open-ended set — new ones land without a code
 * change — so the pill uses one neutral treatment built from
 * `--text-secondary` rather than a per-framework palette, and keeps
 * the value lower-case the way it arrives on the wire (framework
 * names are identifiers, not display prose).
 *
 * Renders nothing for a null / empty framework: events predating
 * framework attribution, and Claude Code plugin sessions, carry
 * none. Returning `null` keeps callers from having to guard.
 */
export function FrameworkPill({
  framework,
  testId,
}: {
  framework: string | null | undefined;
  testId?: string;
}) {
  if (!framework) return null;
  return (
    <span
      data-testid={testId}
      className="rounded-sm font-medium"
      style={{
        padding: "1px 5px",
        fontSize: 10,
        lineHeight: "14px",
        background: "color-mix(in srgb, var(--text-secondary) 12%, transparent)",
        color: "var(--text-secondary)",
        border:
          "1px solid color-mix(in srgb, var(--text-secondary) 28%, transparent)",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
      title={`framework=${framework}`}
    >
      {framework}
    </span>
  );
}
