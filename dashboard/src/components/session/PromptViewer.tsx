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
}: {
  mode: ViewMode;
  onChange: (mode: ViewMode) => void;
  testId: string;
}) {
  return (
    <div className="flex gap-3" role="group" aria-label="View" data-testid={`${testId}-toggle`}>
      {(["pretty", "raw"] as const).map((m) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          data-testid={`${testId}-${m}`}
          className="text-[11px] capitalize pb-0.5"
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
  testId,
  children,
}: {
  raw: unknown;
  label?: React.ReactNode;
  testId: string;
  children: React.ReactNode;
}) {
  const [mode, setMode] = useState<ViewMode>("pretty");
  return (
    <div data-testid={testId} data-view={mode}>
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="min-w-0">{label}</div>
        <ViewToggle mode={mode} onChange={setMode} testId={testId} />
      </div>
      {mode === "pretty" ? (
        children
      ) : (
        <div
          data-testid={`${testId}-raw-json`}
          className="rounded-md p-2.5"
          style={{ background: "var(--bg-elevated)" }}
        >
          <SyntaxJson data={raw} />
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
              {isPlainObject(raw.input) && Object.keys(raw.input).length > 0 && (
                <div className="mt-2">
                  <KeyValueList data={raw.input} />
                </div>
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
  // fetchEventContent resolves null when the content does not exist
  // (capture off for the session). Only this event's result is shown;
  // a failed request ends the spinner and renders nothing.
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

  const messages = Array.isArray(content.messages) ? content.messages : [];
  const provider = content.provider ?? "unknown";
  const model = content.model ?? "";

  return (
    <div className="flex flex-col px-3 py-2">
      {/* Provider header */}
      <div className="flex items-center gap-2 pb-3" style={{ borderBottom: "1px solid var(--border-subtle)" }}>
        <ProviderLogo provider={getProvider(model) !== "unknown" ? getProvider(model) : (provider as "anthropic" | "openai" | "unknown")} size={16} />
        <span className="text-[13px]" style={{ color: "var(--text-secondary)" }}>{provider}</span>
        <span style={{ color: "var(--text-muted)" }}>·</span>
        <span className="font-mono text-[13px]" style={{ color: "var(--text-secondary)" }}>{model}</span>
      </div>

      {/* System prompt */}
      {content.system_prompt != null && (
        <Section title="System">
          <ViewBox key={`${eventId}-system`} raw={content.system_prompt} testId="prompt-box-system" label={<RoleBadge role="system" />}>
            <MessageContent content={content.system_prompt} />
          </ViewBox>
        </Section>
      )}

      {/* Messages */}
      {messages.length > 0 && (
        <Section title="Messages" count={messages.length}>
          <div className="space-y-2">
            {messages.map((msg: Record<string, unknown>, i: number) => {
              const role = String(msg.role ?? `message_${i}`);
              return (
                // Key is event-id-scoped so React doesn't re-use a longer
                // event's DOM nodes (or a box's Pretty/Raw choice) when
                // switching to a shorter event's messages list.
                <ViewBox key={`${eventId}-msg-${i}`} raw={msg} testId={`prompt-box-message-${i}`} label={<RoleBadge role={role} />}>
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
            {content.tools.map((tool: Record<string, unknown>, i: number) => {
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
                  raw={tool}
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
      {content.response != null && (
        <Section title="Response">
          <ViewBox key={`${eventId}-response`} raw={content.response} testId="prompt-box-response">
            <PrettyResponse response={content.response} provider={provider} />
          </ViewBox>
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
      <div data-testid="pretty-json" className="rounded-md p-2" style={{ background: "var(--bg-base)" }}>
        <SyntaxJson data={parsed} />
      </div>
    );
  }
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre
      className="rounded-md p-2 font-mono text-[12px]"
      style={{
        background: "var(--bg-base)",
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
