import { useSession } from "@/hooks/useSession";
import { ClientType, isOtlpSession } from "@/lib/agent-identity";
import type { AgentEvent, Session } from "@/lib/types";

/**
 * An event detail's Prompts tab for an event that stored no content.
 *
 * When no event of the run stored any (``capture_enabled`` false),
 * capture is off for it, and the tab shows the disabled state
 * (CLAUDE.md rule 21). Otherwise capture is on and this event simply
 * has nothing to show (a run's start, a call whose framework sent no
 * messages), which the tab says rather than claiming capture is off,
 * with the reason when the run's framework gives one.
 */
export function NoEventContent({
  event,
  session,
}: {
  event: AgentEvent;
  session: Session | null;
}) {
  if (!session?.capture_enabled) {
    return (
      <div
        data-testid="prompts-capture-disabled"
        className="px-4 py-6 text-[13px]"
        style={{ color: "var(--text-muted)" }}
      >
        Prompt capture is not enabled for this deployment.
      </div>
    );
  }
  const hint = noContentReason(event, session);
  return (
    <div
      data-testid="prompts-no-content-for-event"
      className="space-y-1 px-4 py-6 text-[13px]"
      style={{ color: "var(--text-muted)" }}
    >
      <div>No content was recorded for this event.</div>
      {hint && (
        <div data-testid="prompts-no-content-reason" className="text-xs">
          {hint}
        </div>
      )}
    </div>
  );
}

/**
 * ``NoEventContent`` for a surface that holds the event but not its
 * run (the Events page's event drawer): it reads the run through the
 * shared session cache, and shows nothing until the run has loaded, so
 * the disabled state never flashes on a capture-on run.
 */
export function NoEventContentForEvent({ event }: { event: AgentEvent }) {
  const { data, loading, error } = useSession(event.session_id);
  if (loading && !data) return null;
  if (error && !data) return <NoEventContent event={event} session={null} />;
  return <NoEventContent event={event} session={data?.session ?? null} />;
}

/** Why an event of a capture-on OpenTelemetry GenAI run carries no
 *  content, when the framework's telemetry says; null otherwise. */
export function noContentReason(event: AgentEvent, session: Session): string | null {
  if (!isOtlpSession(session) || session.client_type !== ClientType.Otlp) return null;
  if (event.event_type === "tool_call" && session.framework === "google_adk") {
    return "Google ADK records a tool's arguments and result only inside the next model call's messages; that call's Prompts tab shows them.";
  }
  if (event.event_type === "post_call") {
    return "The framework sent no messages, response or instructions for this call. A call that carries only its tool definitions stores none.";
  }
  return null;
}
