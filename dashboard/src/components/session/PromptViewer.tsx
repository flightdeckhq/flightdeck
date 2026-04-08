import { useState, useEffect } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fetchEventContent } from "@/lib/api";
import type { EventContent } from "@/lib/types";

interface PromptViewerProps {
  eventId: string | null;
}

function CollapsibleSection({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-border">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-1 rounded-none px-3 py-2 text-xs font-semibold"
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {title}
      </Button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

function MessageItem({ message, index }: { message: Record<string, unknown>; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const role = String(message.role ?? `message ${index}`);
  const content =
    typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content, null, 2);

  return (
    <div className="border-b border-border/50 py-1 last:border-b-0">
      <Button
        variant="ghost"
        size="sm"
        className="w-full justify-start gap-1 rounded-none px-0 py-1 text-xs"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        <span
          className="rounded px-1.5 py-0.5 font-mono text-xs"
          style={{
            backgroundColor: "var(--surface-hover)",
            color: "var(--text)",
          }}
        >
          {role}
        </span>
      </Button>
      {expanded && (
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-xs text-text-muted">
          {content}
        </pre>
      )}
    </div>
  );
}

export function PromptViewer({ eventId }: PromptViewerProps) {
  const [content, setContent] = useState<EventContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [notFound, setNotFound] = useState(false);

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

    return () => {
      cancelled = true;
    };
  }, [eventId]);

  if (!eventId) return null;

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <div
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          style={{ color: "var(--text-muted)" }}
        />
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

  return (
    <div className="flex flex-col">
      {/* Provider + model header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-xs text-text-muted">Provider</span>
        <span className="font-mono text-xs">{content.provider}</span>
        <span className="text-xs text-text-muted">Model</span>
        <span className="font-mono text-xs">{content.model}</span>
      </div>

      {/* System prompt */}
      {content.system_prompt != null && (
        <CollapsibleSection title="System" defaultOpen={false}>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-text-muted">
            {content.system_prompt}
          </pre>
        </CollapsibleSection>
      )}

      {/* Messages */}
      {messages.length > 0 && (
        <CollapsibleSection title={`Messages (${messages.length})`} defaultOpen>
          {messages.map((msg: Record<string, unknown>, i: number) => (
            <MessageItem key={i} message={msg} index={i} />
          ))}
        </CollapsibleSection>
      )}

      {/* Tools */}
      {content.tools != null && (
        <CollapsibleSection title="Tools" defaultOpen={false}>
          {Array.isArray(content.tools) ? (
            <ul className="space-y-1">
              {content.tools.map((tool: Record<string, unknown>, i: number) => (
                <li key={i} className="font-mono text-xs text-text-muted">
                  {(tool.name as string) ?? ((tool.function as Record<string, unknown>)?.name as string) ?? JSON.stringify(tool)}
                </li>
              ))}
            </ul>
          ) : (
            <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-text-muted">
              {JSON.stringify(content.tools, null, 2)}
            </pre>
          )}
        </CollapsibleSection>
      )}

      {/* Response */}
      {content.response != null && (
        <CollapsibleSection title="Response" defaultOpen={false}>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-text-muted">
            {typeof content.response === "string"
              ? content.response
              : JSON.stringify(content.response, null, 2)}
          </pre>
        </CollapsibleSection>
      )}
    </div>
  );
}
