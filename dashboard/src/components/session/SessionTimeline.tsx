import type { AgentEvent } from "@/lib/types";
import { EventDetail } from "./EventDetail";

interface SessionTimelineProps {
  events: AgentEvent[];
}

export function SessionTimeline({ events }: SessionTimelineProps) {
  if (events.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-text-muted">
        No events recorded for this session.
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      {events.map((event) => (
        <EventDetail key={event.id} event={event} />
      ))}
    </div>
  );
}
