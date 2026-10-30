import { useKeyedFetch } from "@/hooks/useKeyedFetch";
import { fetchEventContent } from "@/lib/api";
import type { EventContent } from "@/lib/types";

/**
 * The captured text of a ``session_signal`` event: a compaction
 * summary, the instructions given to ``/compact``. The plugin sends it
 * under ``content.response`` keyed by name, only while prompt capture
 * is on. Kept apart from ``PromptViewer`` because a signal's text is
 * not an LLM call's request and response.
 *
 * Test ids: ``signal-content-viewer`` on the root, with ``data-state``
 * ``loading`` / ``empty`` / ``text``, and ``signal-content-<key>`` on
 * each text section.
 */

interface SignalContentViewerProps {
  eventId: string;
  /** Skip the fetch when the caller knows nothing was captured. */
  hasContent: boolean;
}

// Headings for the text keys the plugin sends; any other key is shown
// under its own name.
const SIGNAL_TEXT_LABELS: Record<string, string> = {
  compact_summary: "Compaction summary",
  custom_instructions: "Compaction instructions",
};

/** The string fields of a signal's ``content.response``. */
function signalTexts(content: EventContent | null): [string, string][] {
  const response = content?.response;
  if (response === null || typeof response !== "object" || Array.isArray(response)) return [];
  return Object.entries(response as Record<string, unknown>).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
  );
}

export function SignalContentViewer({ eventId, hasContent }: SignalContentViewerProps) {
  const contentFetch = useKeyedFetch<EventContent | null>(hasContent ? eventId : null, () =>
    fetchEventContent(eventId),
  );
  const content = hasContent && contentFetch.dataKey === eventId ? (contentFetch.data ?? null) : null;

  if (hasContent && contentFetch.loading) {
    return (
      <div
        data-testid="signal-content-viewer"
        data-state="loading"
        className="mt-2 font-mono text-[11px]"
        style={{ color: "var(--text-muted)" }}
      >
        Loading…
      </div>
    );
  }

  const texts = signalTexts(content);
  if (texts.length === 0) {
    return (
      <div
        data-testid="signal-content-viewer"
        data-state="empty"
        className="mt-2 rounded-sm px-2 py-1.5 text-xs"
        style={{
          background: "var(--bg-elevated)",
          border: "1px dashed var(--border-subtle)",
          color: "var(--text-muted)",
        }}
      >
        (no text captured)
      </div>
    );
  }

  return (
    <div data-testid="signal-content-viewer" data-state="text" className="mt-2 space-y-2">
      {texts.map(([key, text]) => (
        <div key={key} data-testid={`signal-content-${key}`}>
          <div
            className="mb-1 text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: "var(--text-muted)" }}
          >
            {SIGNAL_TEXT_LABELS[key] ?? key}
          </div>
          <div
            className="whitespace-pre-wrap rounded-md p-2.5 font-mono text-[12px]"
            style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)", color: "var(--text)" }}
          >
            {text}
          </div>
        </div>
      ))}
    </div>
  );
}
