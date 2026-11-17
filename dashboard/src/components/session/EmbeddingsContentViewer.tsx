import { useState, type CSSProperties, type ReactNode } from "react";
import { useKeyedFetch } from "@/hooks/useKeyedFetch";
import { ChevronDown, ChevronRight, Database } from "lucide-react";
import { fetchEventContent } from "@/lib/api";
import type { EventContent } from "@/lib/types";
import { SyntaxJson } from "@/components/ui/syntax-json";

/**
 * Embedding-shaped content viewer.
 *
 * Modelled distinctly from ``PromptViewer`` because chat shape and
 * embedding shape are genuinely different surfaces -- chat is system
 * + messages + tools + response; embedding is just an ``input`` (no
 * model output content). Reusing PromptViewer would have meant
 * overloading its system/messages/response slots with embedding
 * fields, creating "convenient now, confusing later" debt, so the two
 * shapes stay separate.
 *
 * The embeddings API takes four shapes of ``input``, and the sensor
 * stores the one the call sent as it was sent. The viewer reads the
 * stored value's JSON type (``classifyEmbeddingInput``) and renders:
 *
 *   - ``has_content === false``, or no stored input: muted
 *     "(content not captured)" placeholder. Matches the chat
 *     equivalent's empty-state UX. The content API leaves a null input
 *     out, so a null and an absent input arrive alike.
 *   - a string: one input, its text. Truncated to
 *     ``DEFAULT_PREVIEW_CHARS`` with click-to-expand for the full
 *     text. Mono font matches PromptViewer's text rendering.
 *   - a list of token ids (non-negative integers): one input, labelled
 *     as token ids with their count, the ids as one wrapping
 *     comma-separated sequence. Truncated to
 *     ``TOKEN_IDS_PREVIEW_COUNT`` ids with the same click-to-expand.
 *   - a list of strings, or a list of token-id lists: one input per
 *     item. Header reads ``"<N> inputs"`` with click-to-expand for the
 *     full list, each item rendered separately with its index; a
 *     token-id item is labelled as token ids with its own count.
 *   - anything else (an empty list, a list mixing types, an object, a
 *     number): the stored value as its JSON, never cast to one of the
 *     shapes above.
 *
 * Test ids:
 *   - ``embeddings-content-viewer`` on the root, whose ``data-state``
 *     names the branch: ``loading``, ``empty``, ``string``, ``tokens``,
 *     ``list`` or ``json``.
 *   - ``embeddings-content-state-{loading,empty,string,tokens,list,json}``
 *     on the active branch's container so E2E can branch its assertion
 *     path on which state rendered without parsing visible text.
 *   - ``embeddings-content-token-count`` on a token-id input's count.
 *   - ``embeddings-content-list-kind`` on a token-id list's "token ids"
 *     header label.
 *   - ``embeddings-content-toggle`` on the expand button.
 *   - ``embeddings-content-expanded`` on the post-expand list, whose
 *     items carry ``embeddings-content-list-item-<i>``; a token-id
 *     item adds ``-count`` and ``-ids`` children.
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

/**
 * How many token ids a token-id input shows before "Show full input".
 * A token id of the OpenAI encodings is at most six digits (the
 * largest vocabulary, o200k, has about 200,000 entries), so with its
 * separator one id takes up to eight characters: 35 ids stay within
 * the ``DEFAULT_PREVIEW_CHARS`` a text input shows.
 */
const TOKEN_IDS_PREVIEW_COUNT = 35;

/** Between two token ids: a comma and a space, so the sequence reads
 *  as a list and wraps at the spaces. */
const TOKEN_ID_SEPARATOR = ", ";

/** One input of a list ``input``: its text, or its token ids. */
export type EmbeddingListItem = string | number[];

/** The shape of a stored embeddings ``input``, by its JSON type. */
export type EmbeddingInputShape =
  | { kind: "absent" }
  | { kind: "string"; text: string }
  | { kind: "tokens"; ids: number[] }
  | { kind: "list"; items: EmbeddingListItem[] }
  | { kind: "json"; value: unknown };

/** A token id: a non-negative integer. A fraction or a negative number
 *  is not one, so a list holding one is shown as its JSON. */
function isTokenId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A token-id input: a non-empty list of token ids. */
function isTokenIds(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every(isTokenId);
}

/**
 * Which of the embeddings API's input shapes a stored ``input`` is,
 * decided by the value's JSON type alone: a string; a non-empty list of
 * token ids (one input); a non-empty list of strings, or of token-id
 * lists (one input per item). Null and absent are ``absent``; any other
 * value (an empty list, a list mixing types, an object, a number) is
 * ``json``.
 */
export function classifyEmbeddingInput(input: unknown): EmbeddingInputShape {
  if (input === null || input === undefined) return { kind: "absent" };
  if (typeof input === "string") return { kind: "string", text: input };
  if (isTokenIds(input)) return { kind: "tokens", ids: input };
  if (Array.isArray(input) && input.length > 0) {
    if (input.every((item) => typeof item === "string")) {
      return { kind: "list", items: input as string[] };
    }
    if (input.every(isTokenIds)) {
      return { kind: "list", items: input as number[][] };
    }
  }
  return { kind: "json", value: input };
}

/** ``"1 token"`` / ``"<n> tokens"``. */
function tokenCount(n: number): string {
  return `${n} token${n === 1 ? "" : "s"}`;
}

export function EmbeddingsContentViewer({
  eventId,
  hasContent,
}: EmbeddingsContentViewerProps) {
  const [expanded, setExpanded] = useState(false);

  // No request when the caller knows there is nothing to fetch. Only
  // this event's result is shown.
  const contentFetch = useKeyedFetch<EventContent | null>(hasContent ? eventId : null, () =>
    fetchEventContent(eventId),
  );
  const loading = contentFetch.loading;
  const content: EventContent | null =
    hasContent && contentFetch.dataKey === eventId ? (contentFetch.data ?? null) : null;

  // Nothing captured: either the caller knows there is no content, or
  // the content request came back empty (capture off, or the body is
  // gone). Without the second case a null response showed "Loading…"
  // forever.
  if (!hasContent || (!loading && content === null)) {
    return (
      <div
        data-testid="embeddings-content-viewer"
        data-state="empty"
        className="mt-2 flex items-center gap-2 rounded-sm text-xs"
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

  const onToggle = () => setExpanded((v) => !v);
  const shape = classifyEmbeddingInput(content.input);
  switch (shape.kind) {
    case "string":
      return <SingleInputView text={shape.text} expanded={expanded} onToggle={onToggle} />;
    case "tokens":
      return <TokenIdsInputView ids={shape.ids} expanded={expanded} onToggle={onToggle} />;
    case "list":
      return <ListInputView items={shape.items} expanded={expanded} onToggle={onToggle} />;
    case "json":
      return <JsonInputView value={shape.value} />;
    case "absent":
      // Defensive fallback: has_content was true but the wire payload
      // arrived without an input field (race, schema drift, sensor
      // bug). Render as empty rather than throwing.
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
}

/** The bordered box every captured-input view sits in. */
function InputBox({ state, children }: { state: string; children: ReactNode }) {
  return (
    <div
      data-testid="embeddings-content-viewer"
      data-state={state}
      className="mt-2 rounded-sm"
      style={{
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-subtle)",
        padding: "8px 10px",
      }}
    >
      {children}
    </div>
  );
}

const HEADER_STYLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-secondary)",
};

/** A muted, mono, not-uppercased note beside a header label. */
const HEADER_NOTE_STYLE: CSSProperties = {
  color: "var(--text-muted)",
  fontWeight: 400,
  textTransform: "none",
  letterSpacing: 0,
  fontFamily: "var(--font-mono)",
};

/** The text of one input, as written and wrapping at the box's width. */
const INPUT_TEXT_STYLE: CSSProperties = {
  color: "var(--text)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

/** The header of a single-input view: the icon, "Embedding input", and
 *  what follows it. */
function SingleInputHeader({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-2" style={HEADER_STYLE}>
      <Database size={12} style={{ color: "var(--event-embeddings)" }} />
      <span>Embedding input</span>
      {children}
    </div>
  );
}

function ExpandToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      data-testid="embeddings-content-toggle"
      onClick={onToggle}
      className="mt-2 text-[11px]"
      style={{ color: "var(--accent)" }}
    >
      {expanded ? "Show less" : "Show full input"}
    </button>
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
    <InputBox state="string">
      <SingleInputHeader>
        <span style={HEADER_NOTE_STYLE}>({text.length} chars)</span>
      </SingleInputHeader>
      <div
        data-testid="embeddings-content-state-string"
        className="font-mono text-xs"
        style={INPUT_TEXT_STYLE}
      >
        {preview}
      </div>
      {truncated && <ExpandToggle expanded={expanded} onToggle={onToggle} />}
    </InputBox>
  );
}

/** One input given as token ids: labelled as such, with their count. */
function TokenIdsInputView({
  ids,
  expanded,
  onToggle,
}: {
  ids: number[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const truncated = ids.length > TOKEN_IDS_PREVIEW_COUNT;
  const shown = truncated && !expanded ? ids.slice(0, TOKEN_IDS_PREVIEW_COUNT) : ids;
  const preview = shown.join(TOKEN_ID_SEPARATOR) + (truncated && !expanded ? "…" : "");
  return (
    <InputBox state="tokens">
      <SingleInputHeader>
        <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>·</span>
        <span>Token ids</span>
        <span style={HEADER_NOTE_STYLE}>
          (<span data-testid="embeddings-content-token-count">{tokenCount(ids.length)}</span>)
        </span>
      </SingleInputHeader>
      <div
        data-testid="embeddings-content-state-tokens"
        className="font-mono text-xs"
        style={INPUT_TEXT_STYLE}
      >
        {preview}
      </div>
      {truncated && <ExpandToggle expanded={expanded} onToggle={onToggle} />}
    </InputBox>
  );
}

/** A stored input none of the API's shapes fits, as its JSON. */
function JsonInputView({ value }: { value: unknown }) {
  return (
    <InputBox state="json">
      <SingleInputHeader>
        <span style={HEADER_NOTE_STYLE}>(JSON)</span>
      </SingleInputHeader>
      <div data-testid="embeddings-content-state-json">
        <SyntaxJson data={value} wrap />
      </div>
    </InputBox>
  );
}

function ListInputView({
  items,
  expanded,
  onToggle,
}: {
  items: EmbeddingListItem[];
  expanded: boolean;
  onToggle: () => void;
}) {
  // The classifier admits only lists of one kind: all text or all token ids.
  const tokenIds = items.length > 0 && Array.isArray(items[0]);
  return (
    <InputBox state="list">
      <button
        type="button"
        data-testid="embeddings-content-toggle"
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left"
        style={HEADER_STYLE}
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
        {tokenIds && (
          <>
            <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>·</span>
            <span data-testid="embeddings-content-list-kind">Token ids</span>
          </>
        )}
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
              style={INPUT_TEXT_STYLE}
            >
              {typeof item === "string" ? item : <TokenIdsItem ids={item} index={i} />}
            </li>
          ))}
        </ol>
      )}
    </InputBox>
  );
}

/** One token-id input of a list: its label and count on the item's
 *  first line, after the item's number, and the ids below. */
function TokenIdsItem({ ids, index }: { ids: number[]; index: number }) {
  return (
    <>
      <span data-testid={`embeddings-content-list-item-${index}-count`} style={HEADER_NOTE_STYLE}>
        Token ids ({tokenCount(ids.length)})
      </span>
      <div data-testid={`embeddings-content-list-item-${index}-ids`}>
        {ids.join(TOKEN_ID_SEPARATOR)}
      </div>
    </>
  );
}
