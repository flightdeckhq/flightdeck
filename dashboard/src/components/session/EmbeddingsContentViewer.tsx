import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Database } from "lucide-react";
import { fetchEventContent } from "@/lib/api";
import type { EventContent } from "@/lib/types";

/**
 * Embedding-shaped content viewer (Phase 4 polish, S-EMBED-5).
 *
 * Modelled distinctly from ``PromptViewer`` because chat shape and
 * embedding shape are genuinely different surfaces -- chat is system
 * + messages + tools + response; embedding is just an ``input``
 * (string or list of strings, no model output content). Reusing
 * PromptViewer would have meant overloading its system/messages/
 * response slots with embedding fields, creating "convenient now,
 * confusing later" debt. Per supervisor V-pass answer #1, the two
 * shapes stay separate.
 *
 * Three render branches mapped to the data shape:
 *
 *   - ``has_content === false`` (no captured content): muted
 *     "(content not captured)" placeholder. Matches the chat
 *     equivalent's empty-state UX.
 *   - ``input`` is a string: single-input embed. Truncated to
 *     ``DEFAULT_PREVIEW_CHARS`` with click-to-expand for the full
 *     text. Mono font matches PromptViewer's text rendering.
 *   - ``input`` is an array of strings: batch embed. Header reads
 *     ``"<N> inputs"`` with click-to-expand for the full list,
 *     each item rendered separately with its index.
 *
 * Test ids:
 *   - ``embeddings-content-viewer`` on the root.
 *   - ``embeddings-content-state-{loading,empty,string,list}`` on
 *     the active branch's container so E2E can branch its
 *     assertion path on which state rendered without parsing
 *     visible text.
 *   - ``embeddings-content-toggle`` on the expand button.
 *   - ``embeddings-content-expanded`` on the post-expand container.
 */

interface EmbeddingsContentViewerProps {
  eventId: string;
  /**
   * Skip the API fetch and treat the event as "no content captured"
   * directly. Used when the caller already knows ``has_content`` is
   * false (saves a 404 round-trip from the events API).
   */
  hasContent: boolean;
}

const DEFAULT_PREVIEW_CHARS = 280;

export function EmbeddingsContentViewer({
  eventId,
  hasContent,
}: EmbeddingsContentViewerProps) {
  const [content, setContent] = useState<EventContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!hasContent) {
      // Short-circuit: caller knows there's nothing to fetch.
      setContent(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setContent(null);
    fetchEventContent(eventId).then((result) => {
      if (cancelled) return;
      setLoading(false);
      setContent(result);
    });
    return () => {
      cancelled = true;
    };
  }, [eventId, hasContent]);

  if (!hasContent) {
    return (
      <div
        data-testid="embeddings-content-viewer"
        data-state="empty"
        className="mt-2 flex items-center gap-2 rounded text-xs"
        style={{
          background: "var(--bg-elevated)",
          border: "1px dashed var(--border-subtle)",
          color: "var(--text-muted)",
          padding: "8px 10px",
        }}
      >
        <Database size={12} />
        <span data-testid="embeddings-content-state-empty">
          (content not captured)
        </span>
      </div>
    );
  }

  if (loading || content === null) {
    return (
      <div
        data-testid="embeddings-content-viewer"
        data-state="loading"
        className="mt-2 text-xs"
        style={{ color: "var(--text-muted)", padding: "8px 10px" }}
      >
        <span data-testid="embeddings-content-state-loading">Loading…</span>
      </div>
    );
  }

  const input = content.input;
  if (typeof input === "string") {
    return (
      <SingleInputView
        text={input}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />
    );
  }
  if (Array.isArray(input)) {
    return (
      <ListInputView
        items={input as string[]}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
      />
    );
  }

  // Defensive fallback: has_content was true but the wire payload
  // arrived without an input field (race, schema drift, sensor bug).
  // Render as empty rather than throwing.
  return (
    <div
      data-testid="embeddings-content-viewer"
      data-state="empty"
      className="mt-2 text-xs"
      style={{ color: "var(--text-muted)", padding: "8px 10px" }}
    >
      <span data-testid="embeddings-content-state-empty">
        (content not captured)
      </span>
    </div>
  );
}

function SingleInputView({
  text,
  expanded,
  onToggle,
}: {
  text: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const truncated = text.length > DEFAULT_PREVIEW_CHARS;
  const preview = truncated && !expanded
    ? text.slice(0, DEFAULT_PREVIEW_CHARS) + "…"
    : text;
  return (
    <div
      data-testid="embeddings-content-viewer"
      data-state="string"
      className="mt-2 rounded"
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-subtle)",
        padding: "8px 10px",
      }}
    >
      <div
        className="flex items-center gap-2 mb-2"
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-secondary)",
        }}
      >
        <Database size={12} style={{ color: "var(--event-embeddings)" }} />
        <span>Embedding input</span>
        <span
          style={{
            color: "var(--text-muted)",
            fontWeight: 400,
            textTransform: "none",
            letterSpacing: 0,
            fontFamily: "var(--font-mono)",
          }}
        >
          ({text.length} chars)
        </span>
      </div>
      <div
        data-testid="embeddings-content-state-string"
        className="font-mono text-xs"
        style={{
          color: "var(--text)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {preview}
      </div>
      {truncated && (
        <button
          type="button"
          data-testid="embeddings-content-toggle"
          onClick={onToggle}
          className="mt-2 text-[11px]"
          style={{ color: "var(--accent)" }}
        >
          {expanded ? "Show less" : "Show full input"}
        </button>
      )}
    </div>
  );
}

function ListInputView({
  items,
  expanded,
  onToggle,
}: {
  items: string[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      data-testid="embeddings-content-viewer"
      data-state="list"
      className="mt-2 rounded"
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-subtle)",
        padding: "8px 10px",
      }}
    >
      <button
        type="button"
        data-testid="embeddings-content-toggle"
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left"
        style={{
          fontSize: 11,
          fontWeight: 600,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--text-secondary)",
        }}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown size={12} style={{ color: "var(--text-muted)" }} />
        ) : (
          <ChevronRight size={12} style={{ color: "var(--text-muted)" }} />
        )}
        <Database size={12} style={{ color: "var(--event-embeddings)" }} />
        <span data-testid="embeddings-content-state-list">
          {items.length} input{items.length === 1 ? "" : "s"}
        </span>
      </button>
      {expanded && (
        <ol
          data-testid="embeddings-content-expanded"
          className="mt-2 space-y-2 list-decimal list-inside"
          style={{ color: "var(--text)", fontSize: 12 }}
        >
          {items.map((item, i) => (
            <li
              key={i}
              data-testid={`embeddings-content-list-item-${i}`}
              className="font-mono"
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {item}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
