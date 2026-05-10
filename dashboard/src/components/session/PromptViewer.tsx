import { useState, useEffect } from "react";
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

/* ---- Main component ---- */

export function PromptViewer({ eventId }: PromptViewerProps) {
  const [content, setContent] = useState<EventContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [responseMode, setResponseMode] = useState<"pretty" | "raw">("pretty");

  useEffect(() => {
    if (!eventId) {
      setContent(null);
      setNotFound(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setNotFound(false);
    setContent(null);

    fetchEventContent(eventId).then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (result === null) {
        setNotFound(true);
      } else {
        setContent(result);
      }
    });

    return () => { cancelled = true; };
  }, [eventId]);

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
          <div className="mb-2">
            <RoleBadge role="system" />
          </div>
          <div className="rounded-md p-2.5" style={{ background: "var(--bg-elevated)", fontSize: 13, lineHeight: 1.6, color: "var(--text)", whiteSpace: "pre-wrap" }}>
            {content.system_prompt}
          </div>
        </Section>
      )}

      {/* Messages */}
      {messages.length > 0 && (
        <Section title="Messages" count={messages.length}>
          <div className="space-y-2">
            {messages.map((msg: Record<string, unknown>, i: number) => {
              const role = String(msg.role ?? `message_${i}`);
              const msgContent = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content, null, 2);

              return (
                // Key is event-id-scoped so React doesn't re-use a longer
                // event's DOM nodes when switching to a shorter event's
                // messages list. Bare index would let React reuse the
                // wrong message position on event-id transitions.
                <div key={`${eventId}-msg-${i}`}>
                  <RoleBadge role={role} />
                  <div className="mt-1.5 rounded-md p-2.5" style={{ background: "var(--bg-elevated)", fontSize: 13, lineHeight: 1.6, color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                    {msgContent}
                  </div>
                </div>
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
                <div key={`${eventId}-tool-${i}`} className="rounded-md p-2.5" style={{ background: "var(--bg-elevated)", border: "1px solid var(--border)" }}>
                  <div className="font-mono text-[13px] font-semibold" style={{ color: "var(--event-tool)" }}>{name}</div>
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
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Response */}
      {content.response != null && (
        <Section title="Response">
          {/* Pretty / Raw toggle */}
          <div className="flex gap-3 mb-3">
            {(["pretty", "raw"] as const).map((mode) => (
              <button
                key={mode}
                className="text-[11px] capitalize pb-0.5"
                style={responseMode === mode
                  ? { color: "var(--text)", borderBottom: "1px solid var(--accent)" }
                  : { color: "var(--text-muted)" }}
                onClick={() => setResponseMode(mode)}
              >
                {mode}
              </button>
            ))}
          </div>

          {responseMode === "pretty" ? (
            <PrettyResponse response={content.response} provider={provider} />
          ) : (
            <SyntaxJson
              data={
                content.response !== null && typeof content.response === "object"
                  ? (content.response as Record<string, unknown>)
                  : { raw: content.response }
              }
            />
          )}
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

  // Extract content
  let textBlocks: string[] = [];

  if (provider === "anthropic") {
    const contentArr = resp.content as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(contentArr)) {
      textBlocks = contentArr
        .filter((item) => item.type === "text")
        .map((item) => String(item.text ?? ""));
    }
  } else {
    // OpenAI
    const choices = resp.choices as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(choices) && choices.length > 0) {
      const firstChoice = choices[0];
      const msg = firstChoice?.message as Record<string, unknown> | undefined;
      if (msg?.content) {
        textBlocks = [String(msg.content)];
      }
    }
  }

  return (
    <div>
      {textBlocks.map((text, i) => (
        <div key={i} className="rounded-md p-2.5 mb-2" style={{ background: "var(--bg-elevated)", fontSize: 13, lineHeight: 1.6, color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {text}
        </div>
      ))}
      {textBlocks.length === 0 && (
        <pre className="text-xs text-text-muted whitespace-pre-wrap">{JSON.stringify(response, null, 2)}</pre>
      )}
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
        if (!isPlainObject(raw)) {
          return (
            <pre
              key={i}
              className="rounded-md p-2 font-mono text-[12px]"
              style={{
                background: "var(--bg-elevated)",
                color: "var(--text-muted)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {String(raw)}
            </pre>
          );
        }
        const type = typeof raw.type === "string" ? raw.type : "";
        if (type === "text") {
          const text = typeof raw.text === "string" ? raw.text : JSON.stringify(raw.text);
          return (
            <div
              key={i}
              className="rounded-md p-2.5"
              style={{
                background: "var(--bg-elevated)",
                fontSize: 13,
                lineHeight: 1.6,
                color: "var(--text)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {text}
            </div>
          );
        }
        if (type === "tool_result") {
          return <ToolResultBlock key={i} block={raw} />;
        }
        return (
          <pre
            key={i}
            className="rounded-md p-2 font-mono text-[12px]"
            style={{
              background: "var(--bg-elevated)",
              color: "var(--text)",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {JSON.stringify(raw, null, 2)}
          </pre>
        );
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
