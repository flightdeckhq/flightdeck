import { useKeyedFetch } from "@/hooks/useKeyedFetch";
import { fetchEventContent } from "@/lib/api";
import type { AgentEvent, EventContent } from "@/lib/types";

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
  title: "Title",
  message: "Message",
  command_args: "Arguments",
  task_subject: "Subject",
  task_description: "Description",
  url: "URL",
  requested_schema: "Requested fields",
  content: "Answer",
};

/** The string fields of a signal's ``content.response``. */
function signalTexts(content: EventContent | null): [string, string][] {
  const response = content?.response;
  if (response === null || typeof response !== "object" || Array.isArray(response)) return [];
  // A notification's title reads before its message, a task's subject
  // before its description.
  const order = (key: string) => (key === "title" || key === "task_subject" ? 0 : 1);
  return Object.entries(response as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
    .sort(([a], [b]) => order(a) - order(b));
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

// The signals whose text the plugin always sends while capture is on, so
// an event of one without content means capture is off.
const ALWAYS_CAPTURED_SIGNALS = new Set([
  "context_compacted",
  "notification",
  "task_created",
  "task_completed",
  // Claude Code requires an elicitation request's message.
  "elicitation_requested",
]);

/**
 * The Prompts tab of a ``session_signal`` event, for both event
 * drawers: the captured text when there is some; otherwise the
 * capture-disabled message for a signal whose text is always captured
 * (rule 21), and a plain "no text" line for one that may carry none
 * (a model switch, a ``/compact`` given no instructions).
 */
export function SignalPromptsPanel({ event }: { event: AgentEvent }) {
  if (event.has_content) {
    return (
      <div className="p-4">
        <SignalContentViewer eventId={event.id} hasContent />
      </div>
    );
  }
  const message = ALWAYS_CAPTURED_SIGNALS.has(event.payload?.signal ?? "")
    ? "Prompt capture is not enabled for this deployment."
    : "This event carries no captured text.";
  return (
    <div
      data-testid="signal-prompts-empty"
      className="px-4 py-6 text-[13px]"
      style={{ color: "var(--text-muted)" }}
    >
      {message}
    </div>
  );
}

