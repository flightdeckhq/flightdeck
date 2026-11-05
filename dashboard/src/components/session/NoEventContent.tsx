import { useSession } from "@/hooks/useSession";
import { ClientType, isOtlpSession } from "@/lib/agent-identity";
import type { AgentEvent, Session } from "@/lib/types";

/**
 * Whether capture is on for a run: its stored posture
 * (``capture_prompts`` on ``GET /v1/sessions/:id``) says so, or one of
 * its events stored content (``capture_enabled``; a run that predates
 * the stored posture carries null there). Capture off is the only case
 * the Prompts tab shows its disabled state for (CLAUDE.md rule 21).
 */
export function sessionCaptureOn(
  session: Pick<Session, "capture_prompts" | "capture_enabled"> | null | undefined,
): boolean {
  return session?.capture_prompts === true || session?.capture_enabled === true;
}

/** The Prompts tab's disabled state: capture is off for the run. */
export function CaptureDisabled({ className }: { className?: string }) {
  return (
    <div
      data-testid="prompts-capture-disabled"
      className={className ?? "px-4 py-8 text-center text-xs text-text-muted"}
    >
      Prompt capture is not enabled for this deployment.
    </div>
  );
}

/** True when the run was reported by an agent framework's
 *  OpenTelemetry GenAI instrumentation (``client_type`` ``otlp``). */
function isGenaiRun(session: Session): boolean {
  return isOtlpSession(session) && session.client_type === ClientType.Otlp;
}

/**
 * The run's Prompts tab when none of its events stored content. Capture
 * off: the disabled state. Capture on: the run recorded none, which the
 * tab says rather than claiming capture is off, with why for an agent
 * framework's run (its framework sent nothing to store).
 */
export function NoRunContent({ session }: { session: Session | null }) {
  if (!sessionCaptureOn(session)) return <CaptureDisabled />;
  return (
    <div
      data-testid="prompts-no-content-for-run"
      className="space-y-1 px-4 py-8 text-center text-xs"
      style={{ color: "var(--text-muted)" }}
    >
      <div>No content was recorded for this run.</div>
      {session && isGenaiRun(session) && (
        <div data-testid="prompts-no-content-reason">
          Capture is on, but the framework sent no content for any call: its own content
          capture is off, or its calls carried only tool definitions, which store none.
        </div>
      )}
    </div>
  );
}

/**
 * An event detail's Prompts tab for an event that stored no content.
 * Capture off for its run: the disabled state. Capture on: this event
 * simply has nothing to show (a run's start, a call whose framework
 * sent no messages), which the tab says, with the reason when the
 * run's framework gives one.
 */
export function NoEventContent({
  event,
  session,
}: {
  event: AgentEvent;
  session: Session | null;
}) {
  if (!sessionCaptureOn(session)) {
    return <CaptureDisabled className="px-4 py-6 text-[13px] text-text-muted" />;
  }
  const hint = session ? noContentReason(event, session) : null;
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
  if (!isGenaiRun(session)) return null;
  if (event.event_type === "tool_call" && session.framework === "google_adk") {
    return "Google ADK records a tool's arguments and result only inside the next model call's messages; that call's Prompts tab shows them.";
  }
  if (event.event_type === "post_call") {
    return "The framework sent no messages, response or instructions for this call. A call that carries only its tool definitions stores none.";
  }
  return null;
}
