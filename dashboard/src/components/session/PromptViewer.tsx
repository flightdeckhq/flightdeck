import { useState } from "react";
import { useKeyedFetch } from "@/hooks/useKeyedFetch";
import { ChevronDown, ChevronRight } from "lucide-react";
import { fetchEventContent } from "@/lib/api";
import { getProvider } from "@/lib/models";
import { ProviderLogo } from "@/components/ui/provider-logo";
import { SyntaxJson } from "@/components/ui/syntax-json";
import type { EventContent } from "@/lib/types";

interface PromptViewerProps {
  eventId: string | null;
}

/* ---- Role badge styles ----
 *
 * Backgrounds resolve via `color-mix(in srgb, <theme token> 15%,
 * transparent)` so the chip background re-tints with the active
 * theme. The previous hardcoded `rgba(...)` literals rendered the
 * same colour in neon-dark and clean-light, defeating the palette
 * (Rule 14). Borders follow the same pattern at 30% mix. Text
 * colour resolves directly to the matching token.
 */

function roleChip(token: string): { bg: string; color: string; border: string } {
  return {
    bg: `color-mix(in srgb, ${token} 15%, transparent)`,
    color: token,
    border: `1px solid color-mix(in srgb, ${token} 30%, transparent)`,
  };
}

const roleBadgeStyles: Record<string, { bg: string; color: string; border: string }> = {
  system: roleChip("var(--text-muted)"),
  user: roleChip("var(--event-llm)"),
  assistant: roleChip("var(--accent)"),
  tool: roleChip("var(--event-tool)"),
  tool_result: roleChip("var(--event-tool)"),
};

const defaultRoleBadge = roleChip("var(--text-muted)");

/* ---- Section header ---- */

function Section({
  title,
  count,
  children,
  defaultOpen = true,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 py-2.5 text-[13px] font-semibold cursor-pointer"
        style={{ color: "var(--text)", borderBottom: "1px solid var(--border-subtle)" }}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={14} style={{ color: "var(--text-muted)" }} /> : <ChevronRight size={14} style={{ color: "var(--text-muted)" }} />}
        {title}
        {count != null && <span className="text-xs font-normal" style={{ color: "var(--text-muted)" }}>({count})</span>}
      </button>
      {open && <div className="mt-2 mb-3">{children}</div>}
    </div>
  );
}

/* ---- Role badge ---- */

function RoleBadge({ role }: { role: string }) {
  const style = roleBadgeStyles[role] ?? defaultRoleBadge;
  return (
    <span
      className="font-mono text-[10px] font-semibold uppercase"
      style={{
        background: style.bg,
        color: style.color,
        border: style.border,
        padding: "2px 8px",
        borderRadius: 4,
      }}
    >
      {role}
    </span>
  );
}

/* ---- Pretty / Raw per box ----
 *
 * Every box (system prompt, each message, each tool, the response)
 * carries its own toggle. Pretty renders content blocks for reading and
 * pretty-prints any JSON, including a string that holds JSON; Raw shows
 * the value exactly as the provider received or returned it.
 */

type ViewMode = "pretty" | "raw";

function ViewToggle({
  mode,
  onChange,
  testId,
  name,
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
  testId: string;
  name: string;
}) {
  return (
    <div className="flex gap-3" role="group" aria-label={`View for ${name}`} data-testid={`${testId}-toggle`}>
      {(["pretty", "raw"] as const).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          data-testid={`${testId}-${m}`}
          className="px-1 py-0.5 text-[11px] capitalize"
          style={mode === m
            ? { color: "var(--text)", borderBottom: "1px solid var(--accent)" }
            : { color: "var(--text-muted)" }}
          onClick={() => onChange(m)}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function ViewBox({
  raw,
  label,
  name,
  testId,
  children,
}: {
  raw: unknown;
  label?: React.ReactNode;
  /** What the box holds, for the toggle's accessible name. */
  name: string;
  testId: string;
  children: React.ReactNode;
}) {
  const [mode, setMode] = useState<ViewMode>("pretty");
  return (
    <div data-testid={testId} data-view={mode}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="min-w-0">{label}</div>
        <ViewToggle mode={mode} onChange={setMode} testId={testId} name={name} />
      </div>
      {mode === "pretty" ? (
        children
      ) : (
        <div
          data-testid={`${testId}-raw-json`}
          className="rounded-md p-2.5"
          style={{ background: "var(--bg-elevated)" }}
        >
          {/* Raw wraps at the box's width rather than scrolling sideways. */}
          <SyntaxJson data={raw} wrap />
        </div>
      )}
    </div>
  );
}

/** The parsed value of a string that holds a JSON object or array, else undefined. */
export function parseJsonContainer(text: string): object | undefined {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const textBoxStyle: React.CSSProperties = {
  background: "var(--bg-elevated)",
  fontSize: 13,
  lineHeight: 1.6,
  color: "var(--text)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

function JsonBox({ data }: { data: unknown }) {
  return (
    <div data-testid="pretty-json" className="rounded-md p-2.5" style={{ background: "var(--bg-elevated)" }}>
      <SyntaxJson data={data} />
    </div>
  );
}

/** Text as written, or pretty-printed JSON when the text is a JSON object or array. */
function TextOrJson({ text }: { text: string }) {
  const parsed = parseJsonContainer(text);
  if (parsed !== undefined) return <JsonBox data={parsed} />;
  return (
    <div className="rounded-md p-2.5" style={textBoxStyle}>
      {text}
    </div>
  );
}

/** A message's (or system prompt's) content: a string, or a list of content blocks. */
function MessageContent({ content }: { content: unknown }) {
  if (typeof content === "string") return <TextOrJson text={content} />;
  if (Array.isArray(content)) return <ContentBlocks blocks={content} />;
  if (content === null || content === undefined) {
    return <div className="text-xs" style={{ color: "var(--text-muted)" }}>(empty)</div>;
  }
  return <JsonBox data={content} />;
}

function BlockLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--text-muted)" }}>
      {children}
    </div>
  );
}

/** Provider content blocks, each in the provider's own terms. */
function ContentBlocks({ blocks }: { blocks: unknown[] }) {
  if (blocks.length === 0) {
    return <div className="text-xs" style={{ color: "var(--text-muted)" }}>(empty)</div>;
  }
  return (
    <div className="space-y-2">
      {blocks.map((raw, i) => {
        if (typeof raw === "string") return <TextOrJson key={i} text={raw} />;
        if (!isPlainObject(raw)) return <JsonBox key={i} data={raw} />;
        const type = typeof raw.type === "string" ? raw.type : "";
        if (type === "text" && typeof raw.text === "string") {
          return <TextOrJson key={i} text={raw.text} />;
        }
        if (type === "thinking" || type === "redacted_thinking") {
          const text = typeof raw.thinking === "string" ? raw.thinking : null;
          return (
            <div key={i} data-testid="content-block-thinking">
              <BlockLabel>{type.replace("_", " ")}</BlockLabel>
              {text != null ? (
                <div className="rounded-md p-2.5" style={{ ...textBoxStyle, color: "var(--text-secondary)" }}>{text}</div>
              ) : (
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>(not shown)</div>
              )}
            </div>
          );
        }
        if (type === "tool_use" || type === "server_tool_use") {
          const name = typeof raw.name === "string" ? raw.name : "tool";
          return (
            <div key={i} data-testid="content-block-tool-use" className="rounded-md p-2.5" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
              <div className="font-mono text-[13px] font-semibold" style={{ color: "var(--event-tool)" }}>{name}</div>
              {isPlainObject(raw.input) && Object.keys(raw.input).length > 0 ? (
                <div className="mt-2">
                  <KeyValueList data={raw.input} />
                </div>
              ) : raw.input != null && !isPlainObject(raw.input) ? (
                <div className="mt-2">
                  <BlockValue value={raw.input} />
                </div>
              ) : (
                <div className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>(no input)</div>
              )}
            </div>
          );
        }
        if (type === "tool_result") {
          return (
            <div key={i}>
              <BlockLabel>tool result</BlockLabel>
              <ToolResultBlock block={raw} />
            </div>
          );
        }
        if (type === "image" || type === "document") {
          return (
            <div key={i} className="text-xs" style={{ color: "var(--text-muted)" }}>
              [{type}]
            </div>
          );
        }
        return <JsonBox key={i} data={raw} />;
      })}
    </div>
  );
}

/* ---- Main component ---- */

export function PromptViewer({ eventId }: PromptViewerProps) {
  // fetchEventContent resolves null for any failed fetch: a 404 (capture
  // off for the session) or any other error. Either way the viewer shows
  // the capture-disabled message. Only this event's result is shown.
  const contentFetch = useKeyedFetch<EventContent | null>(eventId || null, () =>
    fetchEventContent(eventId ?? ""),
  );
  const current = contentFetch.dataKey === eventId && contentFetch.error === null;
  const loading = contentFetch.loading;
  const notFound = current && contentFetch.data === null;
  const content: EventContent | null = current ? (contentFetch.data ?? null) : null;

  if (!eventId) return null;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" style={{ color: "var(--text-muted)" }} />
      </div>
    );
  }

  if (notFound) {
    return (
      <div className="px-4 py-8 text-center text-xs text-text-muted">
        Prompt capture is not enabled for this deployment.
      </div>
    );
  }

  if (!content) return null;

  if (content.provider === OTEL_GENAI_PROVIDER) {
    return <OtelGenaiContent content={content} eventId={eventId} />;
  }

  const messages = Array.isArray(content.messages) ? content.messages : [];
  const provider = content.provider ?? "unknown";
  const model = content.model ?? "";
  // A tool call's content row (the sensor's tool_call, mcp_tool_call
  // and mcp_prompt_get, Claude Code's tool_call over OpenTelemetry)
  // keeps its arguments and result in tool_input / tool_output and
  // stores ``{}`` in the response column, which is not a response.
  const hasToolInput = content.tool_input != null;
  const hasToolOutput = content.tool_output != null;
  const responseIsToolPlaceholder =
    (hasToolInput || hasToolOutput) && isPlainObject(content.response) && Object.keys(content.response).length === 0;

  return (
    <div className="flex flex-col px-3 py-2">
      {/* Provider header */}
      <div className="flex items-center gap-2 pb-3" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
        <ProviderLogo provider={getProvider(model) !== "unknown" ? getProvider(model) : (provider as "anthropic" | "openai" | "unknown")} size={16} />
        <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>{provider}</span>
        {model && (
          <>
            <span style={{ color: "var(--text-muted)" }}>·</span>
            <span data-testid="prompt-viewer-model" className="font-mono text-[13px]" style={{ color: "var(--text-secondary)" }}>{model}</span>
          </>
        )}
      </div>

      {/* System prompt */}
      {content.system_prompt != null && (
        <Section title="System">
          <ViewBox key={`${eventId}-system`} raw={content.system_prompt} name="the system prompt" testId="prompt-box-system" label={<RoleBadge role="system" />}>
            <MessageContent content={content.system_prompt} />
          </ViewBox>
        </Section>
      )}

      {/* Messages */}
      {messages.length > 0 && (
        <Section title="Messages" count={messages.length}>
          <div className="space-y-2">
            {messages.map((entry: unknown, i: number) => {
              const msg: Record<string, unknown> = isPlainObject(entry) ? entry : { content: entry };
              const role = String(msg.role ?? `message_${i}`);
              return (
                // Key is event-id-scoped so React doesn't re-use a longer
                // event's DOM nodes (or a box's Pretty/Raw choice) when
                // switching to a shorter event's messages list.
                <ViewBox key={`${eventId}-msg-${i}`} raw={entry} name={`message ${i + 1} (${role})`} testId={`prompt-box-message-${i}`} label={<RoleBadge role={role} />}>
                  <MessageContent content={msg.content} />
                </ViewBox>
              );
            })}
          </div>
        </Section>
      )}

      {/* Tools */}
      {content.tools != null && Array.isArray(content.tools) && content.tools.length > 0 && (
        <Section title="Tools" count={content.tools.length}>
          <div className="space-y-1.5">
            {content.tools.map((entry: unknown, i: number) => {
              const tool: Record<string, unknown> = isPlainObject(entry) ? entry : {};
              const name = (tool.name as string) ?? ((tool.function as Record<string, unknown>)?.name as string) ?? `tool_${i}`;
              // Plugin-captured tool_use calls carry { type, name, input }.
              // Prefer rendering the call (actual input values) when input
              // is present; otherwise fall back to the declaration path
              // (description + input_schema) used by LLM-request tool defs.
              const input = isPlainObject(tool.input) ? tool.input : null;
              const desc = input == null
                ? ((tool.description as string) ?? ((tool.function as Record<string, unknown>)?.description as string) ?? null)
                : null;
              const schema = input == null
                ? ((tool.input_schema as Record<string, unknown>) ?? ((tool.function as Record<string, unknown>)?.parameters as Record<string, unknown>) ?? null)
                : null;
              const props = (schema?.properties as Record<string, Record<string, unknown>>) ?? null;

              return (
                <ViewBox
                  key={`${eventId}-tool-${i}`}
                  raw={entry}
                  name={`tool ${name}`}
                  testId={`prompt-box-tool-${i}`}
                  label={<span className="font-mono text-[13px] font-semibold" style={{ color: "var(--event-tool)" }}>{name}</span>}
                >
                <div className="rounded-md p-2.5" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
                  {input != null && Object.keys(input).length > 0 && (
                    <div className="mt-2" data-testid="tool-use-input">
                      <KeyValueList data={input} />
                    </div>
                  )}
                  {desc && <div className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>{desc}</div>}
                  {props && Object.keys(props).length > 0 && (
                    <>
                      <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--text-muted)" }}>Parameters</div>
                      <div className="mt-1 space-y-0.5">
                        {Object.entries(props).map(([propName, propDef]) => (
                          <div key={propName} className="flex items-center gap-2 font-mono text-xs">
                            <span className="font-medium" style={{ color: "var(--text)" }}>{propName}</span>
                            <span style={{ color: "var(--text-muted)" }}>·</span>
                            <span style={{ color: "var(--text-muted)" }}>{(propDef as Record<string, unknown>).type as string ?? "any"}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {input == null && !desc && !(props && Object.keys(props).length > 0) && (
                    <div className="text-xs" style={{ color: "var(--text-muted)" }}>(no input)</div>
                  )}
                </div>
                </ViewBox>
              );
            })}
          </div>
        </Section>
      )}

      {/* Response */}
      {content.response != null && !responseIsToolPlaceholder && (
        <Section title="Response">
          <ViewBox key={`${eventId}-response`} raw={content.response} name="the response" testId="prompt-box-response">
            <PrettyResponse response={content.response} provider={provider} />
          </ViewBox>
        </Section>
      )}

      {/* A tool call's arguments and result, as stored. */}
      {hasToolInput && (
        <Section title="Arguments">
          <ViewBox key={`${eventId}-tool-input`} raw={content.tool_input} name="the tool's arguments" testId="prompt-box-tool-input">
            <ToolValue value={content.tool_input} />
          </ViewBox>
        </Section>
      )}

      {hasToolOutput && (
        <Section title="Result">
          <ViewBox key={`${eventId}-tool-output`} raw={content.tool_output} name="the tool's result" testId="prompt-box-tool-output">
            <ToolValue value={content.tool_output} />
          </ViewBox>
        </Section>
      )}
    </div>
  );
}

/** True when a stored value holds something to show: not null, and not
 *  an empty string, list or object. */
function hasStoredValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

/** A tool's arguments or result as stored: an object as labelled
 *  fields, text as written (pretty-printed when it holds JSON), any
 *  other value as JSON. */
function ToolValue({ value }: { value: unknown }) {
  if (!hasStoredValue(value)) {
    return <div className="text-xs" style={{ color: "var(--text-muted)" }}>(empty)</div>;
  }
  if (typeof value === "string") return <TextOrJson text={value} />;
  if (isPlainObject(value)) {
    return (
      <div data-testid="tool-value-fields" className="rounded-md p-2.5" style={{ background: "var(--bg-elevated)" }}>
        <KeyValueList data={value} />
      </div>
    );
  }
  return <JsonBox data={value} />;
}

/* ---- OpenTelemetry GenAI content ----
 *
 * An agent framework that reports over OpenTelemetry (Pydantic AI,
 * Strands Agents, OpenAI Agents, Google ADK) sends its messages in
 * shapes of its own: the GenAI conventions' ``{role, parts}`` messages,
 * Strands' Bedrock-style ``{role, content: [{text} | {toolUse} |
 * {toolResult}]}`` under the older conventions, text that is a Python
 * repr of an SDK object. None of them is a provider's wire format, so
 * ingestion stores them as sent under ``provider=otel_genai`` and they
 * render here in their own terms, never converted into the Anthropic
 * or OpenAI shape the branches above read (CLAUDE.md rule 20). A part
 * or block this renderer does not know shows as its JSON, and content
 * with no messages, response or tool input and output shows as stored.
 */

/** The ``event_content.provider`` of OpenTelemetry GenAI content. */
export const OTEL_GENAI_PROVIDER = "otel_genai";

/** The header's name for where OpenTelemetry GenAI content comes from. */
export const OTEL_GENAI_SOURCE_LABEL = "OpenTelemetry GenAI";

/** The content's stored fields that identify it rather than hold it,
 *  left out of the generic view. */
const OTEL_GENAI_ID_FIELDS = new Set(["event_id", "session_id", "provider", "model", "captured_at"]);

/** A stored value as a list of messages: a list as it is, any other
 *  value that holds something as a list of one, and an empty list for
 *  nothing (``[]``, ``{}``, null), which ingestion stores for a call
 *  without a response and for every tool call. */
function genaiList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) return Object.keys(value).length > 0 ? [value] : [];
  if (typeof value === "string") return value.trim() ? [value] : [];
  return value == null ? [] : [value];
}

/** The system instructions: ingestion keeps them as JSON in the text
 *  column, so a column that holds a JSON list or object is that JSON,
 *  and any other text is the instructions as sent. */
function genaiSystem(systemPrompt: string | null): unknown {
  if (systemPrompt == null || systemPrompt === "") return undefined;
  return parseJsonContainer(systemPrompt) ?? systemPrompt;
}

function Muted({ children, testId }: { children: React.ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="text-xs" style={{ color: "var(--text-muted)" }}>
      {children}
    </div>
  );
}

/** A value as the framework sent it: text (pretty-printed when it holds
 *  JSON), an object as labelled fields, a list as message parts. */
function GenaiValue({ value }: { value: unknown }) {
  if (value == null) return <Muted>(none)</Muted>;
  if (typeof value === "string") {
    if (value.length === 0) return <Muted>(empty)</Muted>;
    const parsed = parseJsonContainer(value);
    if (parsed !== undefined) return <GenaiValue value={parsed} />;
    return (
      <div className="rounded-md p-2.5" style={textBoxStyle}>
        {value}
      </div>
    );
  }
  if (Array.isArray(value)) return <GenaiParts parts={value} />;
  if (isPlainObject(value)) {
    if (Object.keys(value).length === 0) return <Muted>(empty)</Muted>;
    return (
      <div className="rounded-md p-2.5" style={{ background: "var(--bg-elevated)" }}>
        <KeyValueList data={value} />
      </div>
    );
  }
  return (
    <div className="rounded-md p-2.5" style={textBoxStyle}>
      {String(value)}
    </div>
  );
}

/** A tool call inside a message: the tool's name and its arguments. */
function GenaiToolCall({ name, args, id }: { name: unknown; args: unknown; id: unknown }) {
  const parsed = typeof args === "string" ? (parseJsonContainer(args) ?? args) : args;
  return (
    <div
      data-testid="genai-part-tool-call"
      className="rounded-md p-2.5"
      style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[13px] font-semibold" style={{ color: "var(--event-tool)" }}>
          {typeof name === "string" && name ? name : "tool"}
        </span>
        {typeof id === "string" && id && (
          <span className="truncate font-mono text-[10px]" style={{ color: "var(--text-muted)" }} title={id}>
            {id}
          </span>
        )}
      </div>
      <div className="mt-2">
        {isPlainObject(parsed) && Object.keys(parsed).length > 0 ? (
          <KeyValueList data={parsed} />
        ) : parsed == null || (isPlainObject(parsed) && Object.keys(parsed).length === 0) ? (
          <Muted>(no arguments)</Muted>
        ) : (
          <BlockValue value={parsed} />
        )}
      </div>
    </div>
  );
}

/** A tool's result inside a message, with the call it answers. */
function GenaiToolResponse({ name, value, id, status }: { name: unknown; value: unknown; id: unknown; status?: unknown }) {
  return (
    <div data-testid="genai-part-tool-response">
      <BlockLabel>
        tool result
        {typeof name === "string" && name ? ` · ${name}` : ""}
        {typeof status === "string" && status ? ` · ${status}` : ""}
      </BlockLabel>
      {typeof id === "string" && id && (
        <div className="mb-1 truncate font-mono text-[10px]" style={{ color: "var(--text-muted)" }} title={id}>
          {id}
        </div>
      )}
      <GenaiValue value={value} />
    </div>
  );
}

/** One part of a message, in the framework's terms. */
function GenaiPart({ part }: { part: unknown }) {
  if (typeof part === "string") return <TextOrJson text={part} />;
  if (!isPlainObject(part)) return <JsonBox data={part} />;
  const type = typeof part.type === "string" ? part.type : "";
  // The GenAI semantic conventions' message parts.
  if (type === "text" && typeof part.content === "string") {
    return <TextOrJson text={part.content} />;
  }
  if (type === "reasoning" && typeof part.content === "string") {
    return (
      <div data-testid="genai-part-reasoning">
        <BlockLabel>reasoning</BlockLabel>
        <div className="rounded-md p-2.5" style={{ ...textBoxStyle, color: "var(--text-secondary)" }}>
          {part.content}
        </div>
      </div>
    );
  }
  if (type === "tool_call" || type === "server_tool_call") {
    return <GenaiToolCall name={part.name} args={part.arguments} id={part.id} />;
  }
  if (type === "tool_call_response" || type === "server_tool_call_response") {
    return <GenaiToolResponse name={part.name} value={part.response ?? part.result} id={part.id} />;
  }
  if (type === "uri" || type === "blob" || type === "file") {
    const detail = [part.mime_type, part.modality, type === "uri" ? part.uri : null]
      .filter((v): v is string => typeof v === "string" && v.length > 0)
      .join(" · ");
    return <Muted>[{type}{detail ? ` · ${detail}` : ""}]</Muted>;
  }
  // Strands' Bedrock-style content blocks (the older GenAI conventions).
  if (!type) {
    if (typeof part.text === "string" && Object.keys(part).length === 1) {
      return <TextOrJson text={part.text} />;
    }
    if (isPlainObject(part.toolUse)) {
      const use = part.toolUse;
      return <GenaiToolCall name={use.name} args={use.input} id={use.toolUseId} />;
    }
    if (isPlainObject(part.toolResult)) {
      const result = part.toolResult;
      return <GenaiToolResponse name={null} value={result.content} id={result.toolUseId} status={result.status} />;
    }
  }
  return <JsonBox data={part} />;
}

function GenaiParts({ parts }: { parts: unknown[] }) {
  if (parts.length === 0) return <Muted>(empty)</Muted>;
  return (
    <div className="space-y-2">
      {parts.map((part, i) => (
        <GenaiPart key={i} part={part} />
      ))}
    </div>
  );
}

/** A message's body: its ``parts`` (the GenAI conventions), else its
 *  ``content`` (Strands' older events), else its ``message`` (Strands'
 *  older choice event), else the message as stored. */
function GenaiMessageBody({ entry }: { entry: unknown }) {
  if (!isPlainObject(entry)) return <GenaiValue value={entry} />;
  for (const key of ["parts", "content", "message"] as const) {
    const v = entry[key];
    if (Array.isArray(v)) return <GenaiParts parts={v} />;
    if (typeof v === "string") return <TextOrJson text={v} />;
  }
  const rest = Object.fromEntries(
    Object.entries(entry).filter(([k]) => k !== "role" && k !== "finish_reason"),
  );
  return Object.keys(rest).length > 0 ? <JsonBox data={rest} /> : <Muted>(empty)</Muted>;
}

function GenaiMessageBox({
  entry,
  index,
  kind,
  eventId,
}: {
  entry: unknown;
  index: number;
  kind: "message" | "response";
  eventId: string;
}) {
  const msg = isPlainObject(entry) ? entry : null;
  const role =
    msg && typeof msg.role === "string" && msg.role
      ? msg.role
      : kind === "response"
        ? "assistant"
        : `message_${index}`;
  const finish = msg && typeof msg.finish_reason === "string" ? msg.finish_reason : null;
  return (
    <ViewBox
      key={`${eventId}-${kind}-${index}`}
      raw={entry}
      name={`${kind} ${index + 1} (${role})`}
      testId={`prompt-box-${kind}-${index}`}
      label={
        <span className="flex items-center gap-2">
          <RoleBadge role={role} />
          {finish && (
            <span
              data-testid="genai-finish-reason"
              className="font-mono text-[10px]"
              style={{ color: "var(--text-muted)" }}
              title="Why the model stopped"
            >
              {finish}
            </span>
          )}
        </span>
      }
    >
      <GenaiMessageBody entry={entry} />
    </ViewBox>
  );
}

/** A tool definition the call offered the model. */
function GenaiToolDefinition({ entry, index, eventId }: { entry: unknown; index: number; eventId: string }) {
  const tool = isPlainObject(entry) ? entry : {};
  const fn = isPlainObject(tool.function) ? tool.function : {};
  const name =
    typeof tool.name === "string" ? tool.name : typeof fn.name === "string" ? fn.name : `tool_${index}`;
  const desc =
    typeof tool.description === "string"
      ? tool.description
      : typeof fn.description === "string"
        ? fn.description
        : null;
  const schema = isPlainObject(tool.parameters)
    ? tool.parameters
    : isPlainObject(fn.parameters)
      ? fn.parameters
      : null;
  const props = schema && isPlainObject(schema.properties) ? schema.properties : null;
  return (
    <ViewBox
      key={`${eventId}-tool-${index}`}
      raw={entry}
      name={`tool ${name}`}
      testId={`prompt-box-tool-${index}`}
      label={
        <span className="font-mono text-[13px] font-semibold" style={{ color: "var(--event-tool)" }}>
          {name}
        </span>
      }
    >
      <div className="rounded-md p-2.5" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
        {desc && <div className="text-xs" style={{ color: "var(--text-secondary)" }}>{desc}</div>}
        {props && Object.keys(props).length > 0 && (
          <>
            <div className="mt-2 text-[10px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--text-muted)" }}>
              Parameters
            </div>
            <div className="mt-1 space-y-0.5">
              {Object.entries(props).map(([propName, propDef]) => (
                <div key={propName} className="flex items-center gap-2 font-mono text-xs">
                  <span className="font-medium" style={{ color: "var(--text)" }}>{propName}</span>
                  <span style={{ color: "var(--text-muted)" }}>·</span>
                  <span style={{ color: "var(--text-muted)" }}>
                    {isPlainObject(propDef) && typeof propDef.type === "string" ? propDef.type : "any"}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        {!desc && !(props && Object.keys(props).length > 0) && <Muted>(no parameters)</Muted>}
      </div>
    </ViewBox>
  );
}

function OtelGenaiContent({ content, eventId }: { content: EventContent; eventId: string }) {
  const model = content.model ?? "";
  const provider = getProvider(model);
  const system = genaiSystem(content.system_prompt);
  const messages = Array.isArray(content.messages) ? content.messages : [];
  const response = genaiList(content.response);
  const tools = Array.isArray(content.tools) ? content.tools : [];
  const hasArgs = hasStoredValue(content.tool_input);
  const hasResult = hasStoredValue(content.tool_output);
  const recognised =
    system !== undefined || messages.length > 0 || response.length > 0 || hasArgs || hasResult;
  // Content with none of the above (tool definitions alone, or a field
  // this renderer does not know) shows every stored field as it is.
  const stored = Object.fromEntries(
    Object.entries(content).filter(([k, v]) => !OTEL_GENAI_ID_FIELDS.has(k) && hasStoredValue(v)),
  );

  return (
    <div data-testid="prompt-viewer-otel-genai" className="flex flex-col px-3 py-2">
      <div className="flex items-center gap-2 pb-3" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
        {model && provider !== "unknown" && <ProviderLogo provider={provider} size={16} />}
        <span
          data-testid="prompt-viewer-source"
          className="text-[13px]"
          style={{ color: "var(--text-secondary)" }}
          title="Stored as the framework sent it over OpenTelemetry"
        >
          {OTEL_GENAI_SOURCE_LABEL}
        </span>
        {model && (
          <>
            <span style={{ color: "var(--text-muted)" }}>·</span>
            <span className="font-mono text-[13px]" style={{ color: "var(--text-secondary)" }}>{model}</span>
          </>
        )}
      </div>

      {system !== undefined && (
        <Section title="System">
          <ViewBox key={`${eventId}-system`} raw={system} name="the system instructions" testId="prompt-box-system" label={<RoleBadge role="system" />}>
            <GenaiValue value={system} />
          </ViewBox>
        </Section>
      )}

      {messages.length > 0 && (
        <Section title="Messages" count={messages.length}>
          <div className="space-y-2">
            {messages.map((entry, i) => (
              <GenaiMessageBox key={`${eventId}-message-${i}`} entry={entry} index={i} kind="message" eventId={eventId} />
            ))}
          </div>
        </Section>
      )}

      {response.length > 0 && (
        <Section title="Response" count={response.length}>
          <div className="space-y-2">
            {response.map((entry, i) => (
              <GenaiMessageBox key={`${eventId}-response-${i}`} entry={entry} index={i} kind="response" eventId={eventId} />
            ))}
          </div>
        </Section>
      )}

      {hasArgs && (
        <Section title="Arguments">
          <ViewBox key={`${eventId}-tool-input`} raw={content.tool_input} name="the tool's arguments" testId="prompt-box-tool-input">
            <GenaiValue value={content.tool_input} />
          </ViewBox>
        </Section>
      )}

      {hasResult && (
        <Section title="Result">
          <ViewBox key={`${eventId}-tool-output`} raw={content.tool_output} name="the tool's result" testId="prompt-box-tool-output">
            <GenaiValue value={content.tool_output} />
          </ViewBox>
        </Section>
      )}

      {tools.length > 0 && (
        <Section title="Tools" count={tools.length} defaultOpen={!recognised}>
          <div className="space-y-1.5">
            {tools.map((entry, i) => (
              <GenaiToolDefinition key={`${eventId}-tool-${i}`} entry={entry} index={i} eventId={eventId} />
            ))}
          </div>
        </Section>
      )}

      {!recognised && tools.length === 0 && (
        <Section title="Content">
          <div data-testid="prompt-viewer-otel-genai-generic" className="space-y-2">
            <Muted>This content carries no messages, response or tool input; it is shown as stored.</Muted>
            {Object.keys(stored).length > 0 ? (
              <ViewBox key={`${eventId}-stored`} raw={stored} name="the stored content" testId="prompt-box-stored">
                <div className="rounded-md p-2.5" style={{ background: "var(--bg-elevated)" }}>
                  <KeyValueList data={stored} />
                </div>
              </ViewBox>
            ) : (
              <Muted>(empty)</Muted>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}

/* ---- Pretty response renderer ---- */

function PrettyResponse({ response, provider }: { response: unknown; provider: string }) {
  if (!response) {
    return <pre className="text-xs text-text-muted whitespace-pre-wrap">{String(response)}</pre>;
  }

  // Plugin-captured tool_call shape: response is an array of content blocks
  // like { type: "tool_result", content: "<stringified JSON>" } or
  // { type: "text", text: "..." } -- not an Anthropic/OpenAI response object.
  if (Array.isArray(response)) {
    if (response.length === 0) {
      return <div className="text-xs" style={{ color: "var(--text-muted)" }}>(no response)</div>;
    }
    return <ToolResponseBlocks blocks={response} />;
  }

  if (typeof response === "string") {
    return <TextOrJson text={response} />;
  }

  if (typeof response !== "object") {
    return <pre className="text-xs text-text-muted whitespace-pre-wrap">{String(response)}</pre>;
  }

  const resp = response as Record<string, unknown>;

  // Extract usage
  const usage = resp.usage as Record<string, number> | undefined;
  const tokensIn = usage?.input_tokens ?? usage?.prompt_tokens;
  const tokensOut = usage?.output_tokens ?? usage?.completion_tokens;

  // Extract content in the provider's own shape: Anthropic returns
  // content blocks; OpenAI returns choices[0].message with content and
  // tool_calls (whose arguments are a JSON string).
  let body: React.ReactNode = null;

  if (provider === "anthropic") {
    if (Array.isArray(resp.content) && resp.content.length > 0) {
      body = <ContentBlocks blocks={resp.content} />;
    }
  } else {
    const choices = resp.choices as Array<Record<string, unknown>> | undefined;
    const msg = Array.isArray(choices) ? (choices[0]?.message as Record<string, unknown> | undefined) : undefined;
    const toolCalls = Array.isArray(msg?.tool_calls) ? (msg.tool_calls as unknown[]) : [];
    if (msg && (msg.content || toolCalls.length > 0)) {
      body = (
        <div className="space-y-2">
          {msg.content != null && msg.content !== "" && <MessageContent content={msg.content} />}
          {toolCalls.map((call, i) => {
            const fn = isPlainObject(call) && isPlainObject(call.function) ? call.function : null;
            const args = fn && typeof fn.arguments === "string" ? parseJsonContainer(fn.arguments) : undefined;
            return (
              <div key={i} data-testid="content-block-tool-use" className="rounded-md p-2.5" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
                <div className="font-mono text-[13px] font-semibold" style={{ color: "var(--event-tool)" }}>
                  {fn && typeof fn.name === "string" ? fn.name : "tool"}
                </div>
                <div className="mt-2">
                  {isPlainObject(args) ? (
                    <KeyValueList data={args} />
                  ) : (
                    <BlockValue value={fn?.arguments ?? call} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      );
    }
  }

  return (
    <div>
      {body ?? <JsonBox data={response} />}
      {(tokensIn != null || tokensOut != null) && (
        <div className="mt-2 font-mono text-[11px]" style={{ color: "var(--text-muted)" }}>
          {tokensIn != null && <span>Tokens in: {tokensIn.toLocaleString()}</span>}
          {tokensIn != null && tokensOut != null && <span> · </span>}
          {tokensOut != null && <span>Tokens out: {tokensOut.toLocaleString()}</span>}
        </div>
      )}
    </div>
  );
}

/* ---- Structured value helpers (tool_use input, tool_result fields) ---- */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function needsMultiline(v: unknown): boolean {
  if (typeof v === "string") return v.includes("\n") || v.length > 60;
  if (v !== null && typeof v === "object") return true;
  return false;
}

function InlineValue({ value }: { value: unknown }) {
  if (value === null || value === undefined) {
    return <span style={{ color: "var(--text-muted)" }}>(null)</span>;
  }
  if (typeof value === "string") {
    if (value.length === 0) {
      return <span style={{ color: "var(--text-muted)" }}>(empty)</span>;
    }
    return <span style={{ color: "var(--text)" }}>{value}</span>;
  }
  return <span style={{ color: "var(--text)" }}>{String(value)}</span>;
}

function BlockValue({ value }: { value: unknown }) {
  if (typeof value === "string" && value.length === 0) {
    return <span className="font-mono text-[12px]" style={{ color: "var(--text-muted)" }}>(empty)</span>;
  }
  const parsed = typeof value === "string" ? parseJsonContainer(value) : value;
  if (parsed !== null && typeof parsed === "object") {
    return (
      <div data-testid="pretty-json" className="rounded-md p-2" style={{ background: "var(--bg)" }}>
        <SyntaxJson data={parsed} />
      </div>
    );
  }
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre
      className="rounded-md p-2 font-mono text-[12px]"
      style={{
        background: "var(--bg)",
        color: "var(--text)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        margin: 0,
      }}
    >
      {text}
    </pre>
  );
}

function KeyValueList({ data }: { data: Record<string, unknown> }) {
  const entries = Object.entries(data);
  return (
    <div className="space-y-1.5">
      {entries.map(([key, value]) => {
        if (needsMultiline(value)) {
          return (
            <div key={key} className="flex flex-col gap-1">
              <span
                data-testid="kv-label"
                className="font-mono text-[10px] font-semibold uppercase tracking-[0.06em]"
                style={{ color: "var(--text-muted)" }}
              >
                {key}
              </span>
              <BlockValue value={value} />
            </div>
          );
        }
        return (
          <div key={key} className="flex items-baseline gap-2 font-mono text-[12px]">
            <span
              data-testid="kv-label"
              className="font-medium"
              style={{ color: "var(--text-muted)" }}
            >
              {key}:
            </span>
            <InlineValue value={value} />
          </div>
        );
      })}
    </div>
  );
}

/* ---- Tool response block renderers (tool_call Pretty view) ---- */

function ToolResponseBlocks({ blocks }: { blocks: unknown[] }) {
  return (
    <div className="space-y-2">
      {blocks.map((raw, i) => {
        if (isPlainObject(raw) && raw.type === "tool_result") {
          return <ToolResultBlock key={i} block={raw} />;
        }
        return <ContentBlocks key={i} blocks={[raw]} />;
      })}
    </div>
  );
}

function ToolResultBlock({ block }: { block: Record<string, unknown> }) {
  const rawContent = block.content;
  const contentString = typeof rawContent === "string" ? rawContent : null;

  // Parse nested JSON content so structured fields (stdout, stderr,
  // interrupted, isImage, ...) render as a labeled list rather than
  // escape-encoded soup. Parse-failure falls back to the raw string.
  let parsed: unknown = undefined;
  if (contentString != null) {
    try {
      parsed = JSON.parse(contentString);
    } catch {
      parsed = undefined;
    }
  }

  if (Array.isArray(rawContent)) {
    return <ContentBlocks blocks={rawContent} />;
  }

  if (Array.isArray(parsed)) {
    return <JsonBox data={parsed} />;
  }

  if (isPlainObject(parsed)) {
    return (
      <div
        data-testid="tool-result-parsed"
        className="rounded-md p-2.5"
        style={{ background: "var(--bg-elevated)" }}
      >
        <KeyValueList data={parsed} />
      </div>
    );
  }

  if (contentString != null) {
    // Plugin truncates tool output at 2000 chars, appending U+2026 (…).
    // Surface that so the user knows this is the cap, not a render bug.
    const truncated = contentString.endsWith("\u2026");
    return (
      <div data-testid="tool-result-raw">
        <pre
          className="rounded-md p-2.5 font-mono text-[12px]"
          style={{
            background: "var(--bg-elevated)",
            color: "var(--text)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: 0,
          }}
        >
          {contentString}
        </pre>
        {truncated && (
          <div
            data-testid="tool-result-truncated"
            className="mt-1 font-mono text-[10px] italic"
            style={{ color: "var(--text-muted)" }}
          >
            … (truncated)
          </div>
        )}
      </div>
    );
  }

  return (
    <pre
      className="rounded-md p-2.5 font-mono text-[12px]"
      style={{
        background: "var(--bg-elevated)",
        color: "var(--text)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {JSON.stringify(rawContent, null, 2)}
    </pre>
  );
}
