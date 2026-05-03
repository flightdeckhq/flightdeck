import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import type { AgentEvent, Session, SessionListItem, SubagentMessage } from "@/lib/types";
import { fetchEventContent, fetchSession, fetchSessions } from "@/lib/api";
import { truncateSessionId } from "@/lib/events";
import { SubAgentLostDot } from "@/components/facets/SubAgentRolePill";

/**
 * D126 Sub-agents tab. Three sections:
 *
 *   * SPAWNED FROM — shown when this session is a sub-agent (has a
 *     ``parent_session_id``). Identifies the parent session by
 *     agent_name + role + a deep link that swaps the drawer to the
 *     parent.
 *   * SUB-AGENTS — shown when this session has spawned at least
 *     one child. Lists every child session with its role, state,
 *     and a link that opens the child in the drawer.
 *   * MESSAGES — incoming + outgoing cross-agent messages. Inline
 *     bodies render directly; bodies above the 8 KiB inline
 *     threshold (D119 overflow contract) lazy-fetch via
 *     ``GET /v1/events/{id}/content``.
 *
 * The tab self-hides via the SessionDrawer wiring when none of the
 * three sections has content (root session, no children, no
 * messages). When capture_prompts=false the messages section
 * renders the standard disabled message instead of an empty list,
 * matching the Prompts tab disabled-state contract.
 */
export function SubAgentsTab({
  session,
  events,
  onOpenSession,
}: {
  session: Session;
  events: AgentEvent[];
  /** Called when the user clicks a parent / child session link. The
   *  drawer rebinds to the supplied session_id, replacing the
   *  current view. */
  onOpenSession: (sessionId: string) => void;
}) {
  const isChild = !!session.parent_session_id;

  // The session_start event carries the incoming_message body for
  // sub-agent children; session_end carries outgoing_message.
  // Pre-Phase-7 sessions don't have these payload fields and the
  // section renders empty + (for capture-on sessions) a "no
  // messages captured" footer.
  const sessionStart = useMemo(
    () => events.find((e) => e.event_type === "session_start"),
    [events],
  );
  const sessionEnd = useMemo(
    () => events.find((e) => e.event_type === "session_end"),
    [events],
  );

  return (
    <div
      className="flex flex-col gap-4 p-3"
      data-testid="sub-agents-tab-content"
    >
      {isChild && session.parent_session_id && (
        <SpawnedFromSection
          parentSessionId={session.parent_session_id}
          onOpenSession={onOpenSession}
        />
      )}
      <SubAgentsSection
        sessionId={session.session_id}
        onOpenSession={onOpenSession}
      />
      <MessagesSection
        sessionStart={sessionStart}
        sessionEnd={sessionEnd}
        captureEnabled={session.capture_enabled === true}
      />
    </div>
  );
}

/* ---------------- SPAWNED FROM ---------------- */

function SpawnedFromSection({
  parentSessionId,
  onOpenSession,
}: {
  parentSessionId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const [parent, setParent] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fetchSession(parentSessionId, 1)
      .then((d) => {
        if (alive) setParent(d.session);
      })
      .catch(() => {
        if (alive) setParent(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [parentSessionId]);

  return (
    <Section title="Spawned from" testId="sub-agents-spawned-from">
      {loading && <RowEmpty>Loading parent session…</RowEmpty>}
      {!loading && !parent && (
        <RowEmpty>
          Parent session{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>
            {truncateSessionId(parentSessionId)}
          </code>{" "}
          is not yet known. The platform writes a stub when a child
          arrives ahead of its parent; the row will populate once the
          parent's session_start lands.
        </RowEmpty>
      )}
      {!loading && parent && (
        <button
          type="button"
          onClick={() => onOpenSession(parent.session_id)}
          data-testid="sub-agents-spawned-from-link"
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "8px 10px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            cursor: "pointer",
            textAlign: "left",
            width: "100%",
          }}
        >
          <ChevronRight size={14} style={{ color: "var(--text-muted)" }} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: "var(--text)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {parent.agent_name ?? parent.flavor}
            </div>
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono)",
              }}
            >
              {truncateSessionId(parent.session_id)} ·{" "}
              {parent.state}
            </div>
          </span>
        </button>
      )}
    </Section>
  );
}

/* ---------------- SUB-AGENTS ---------------- */

function SubAgentsSection({
  sessionId,
  onOpenSession,
}: {
  sessionId: string;
  onOpenSession: (sessionId: string) => void;
}) {
  const [children, setChildren] = useState<SessionListItem[] | null>(null);

  useEffect(() => {
    let alive = true;
    fetchSessions({ parent_session_id: sessionId, limit: 100 })
      .then((r) => {
        if (alive) setChildren(r.sessions);
      })
      .catch(() => {
        if (alive) setChildren([]);
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  if (children === null) {
    return (
      <Section title="Sub-agents" testId="sub-agents-children">
        <RowEmpty>Loading…</RowEmpty>
      </Section>
    );
  }
  if (children.length === 0) {
    return null;
  }

  return (
    <Section
      title={`Sub-agents (${children.length})`}
      testId="sub-agents-children"
    >
      <ul
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          listStyle: "none",
          padding: 0,
          margin: 0,
        }}
      >
        {children.map((c) => (
          <li key={c.session_id}>
            <button
              type="button"
              onClick={() => onOpenSession(c.session_id)}
              data-testid={`sub-agents-child-row-${c.session_id}`}
              style={{
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "6px 10px",
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 8,
                cursor: "pointer",
                textAlign: "left",
              }}
            >
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 10,
                  padding: "2px 6px",
                  borderRadius: 3,
                  background:
                    "color-mix(in srgb, var(--accent) 12%, transparent)",
                  color: "var(--accent)",
                  flexShrink: 0,
                }}
              >
                {c.agent_role ?? "(role unknown)"}
              </span>
              <span
                style={{
                  fontSize: 12,
                  color: "var(--text)",
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {truncateSessionId(c.session_id)}
              </span>
              <span
                style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                }}
              >
                {c.state}
              </span>
              {c.state === "lost" && (
                <SubAgentLostDot
                  testId={`sub-agents-child-lost-dot-${c.session_id}`}
                />
              )}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/* ---------------- MESSAGES ---------------- */

function MessagesSection({
  sessionStart,
  sessionEnd,
  captureEnabled,
}: {
  sessionStart: AgentEvent | undefined;
  sessionEnd: AgentEvent | undefined;
  captureEnabled: boolean;
}) {
  const incoming = sessionStart?.payload?.incoming_message;
  const outgoing = sessionEnd?.payload?.outgoing_message;

  const hasAny = !!incoming || !!outgoing;

  if (!captureEnabled) {
    return (
      <Section title="Messages" testId="sub-agents-messages">
        <RowEmpty>
          Prompt capture is not enabled for this deployment.
        </RowEmpty>
      </Section>
    );
  }

  if (!hasAny) {
    // Either a root session (no cross-agent messages exist) or a
    // sub-agent that hasn't emitted session_start with a body yet.
    // No section in either case — keeps the tab compact.
    return null;
  }

  return (
    <Section title="Messages" testId="sub-agents-messages">
      {incoming && sessionStart && (
        <MessageBlock
          label="Incoming"
          message={incoming}
          eventId={sessionStart.id}
        />
      )}
      {outgoing && sessionEnd && (
        <MessageBlock
          label="Outgoing"
          message={outgoing}
          eventId={sessionEnd.id}
        />
      )}
    </Section>
  );
}

function MessageBlock({
  label,
  message,
  eventId,
}: {
  label: string;
  message: SubagentMessage;
  eventId: string;
}) {
  // ``has_content=true`` is the D119 overflow discriminator. Inline
  // body is empty; the full message lives in event_content. Lazy-
  // fetch on first render so a long thread of messages doesn't
  // hammer the API. ``loaded`` once false-positively indicates "fetch
  // in flight"; the empty-string fallback below distinguishes the
  // overflow-fetch-failed case.
  const [overflowBody, setOverflowBody] = useState<string | null>(null);
  const [loadingOverflow, setLoadingOverflow] = useState(false);

  useEffect(() => {
    if (!message.has_content) return;
    let alive = true;
    setLoadingOverflow(true);
    fetchEventContent(eventId)
      .then((c) => {
        if (!alive) return;
        // Worker stores the full body in event_content.input
        // (string for the D126 case — contrast Phase 4 embeddings
        // which can be a list). Fall back to system_prompt /
        // response if a future writer change moves the field.
        const raw = c?.input;
        const text = typeof raw === "string" ? raw : raw == null ? "" : JSON.stringify(raw, null, 2);
        setOverflowBody(text);
      })
      .catch(() => {
        if (alive) setOverflowBody("");
      })
      .finally(() => {
        if (alive) setLoadingOverflow(false);
      });
    return () => {
      alive = false;
    };
  }, [message.has_content, eventId]);

  const body = message.has_content ? overflowBody : message.message;
  const isLoading = message.has_content && loadingOverflow;

  return (
    <div
      data-testid={`sub-agents-message-${label.toLowerCase()}`}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
        }}
      >
        <span>{label}</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontWeight: 400,
            letterSpacing: "0.02em",
            textTransform: "none",
          }}
        >
          {message.bytes.toLocaleString()} bytes
          {message.has_content && " · overflow"}
        </span>
      </div>
      {isLoading && <RowEmpty>Loading message body…</RowEmpty>}
      {!isLoading && body !== null && body !== "" && (
        <pre
          style={{
            margin: 0,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            background: "var(--bg)",
            padding: 8,
            borderRadius: 4,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            maxHeight: 300,
            overflowY: "auto",
            color: "var(--text)",
          }}
        >
          {body}
        </pre>
      )}
      {!isLoading && (body === "" || body === null) && message.has_content && (
        <RowEmpty>
          Overflow body could not be loaded.{" "}
          <Link
            to={`/v1/events/${eventId}/content`}
            style={{ color: "var(--accent)" }}
            target="_blank"
            rel="noreferrer"
          >
            Open raw
          </Link>
        </RowEmpty>
      )}
    </div>
  );
}

/* ---------------- shared chrome ---------------- */

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div data-testid={testId} className="flex flex-col gap-2">
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function RowEmpty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: "var(--text-muted)",
        fontStyle: "italic",
      }}
    >
      {children}
    </div>
  );
}
