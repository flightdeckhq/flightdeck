import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { AgentEvent, Session, SessionDetail, SessionListItem, SubagentMessage } from "@/lib/types";
import { fetchEventContent, fetchSession, fetchSessions } from "@/lib/api";
import { truncateSessionId } from "@/lib/events";
import { SubAgentLostDot } from "@/components/facets/SubAgentRolePill";

/**
 * D126 § 7.fix.E — SessionDrawer Sub-agents tab. Three layouts per
 * design doc § 4.2:
 *
 *   * Parent only (has children, no parent): SUB-AGENTS section only.
 *   * Child only (has parent, no children): SPAWNED FROM section
 *     only, plus INPUT / OUTPUT previews captured on this session's
 *     own session_start / session_end.
 *   * Both (depth-2): SPAWNED FROM on top + SUB-AGENTS below.
 *
 * MESSAGES per child (parent-side): each child entry carries an
 * INPUT preview (200 chars) + OUTPUT preview (200 chars). Bodies
 * above the 8 KiB inline threshold (D119 overflow contract) lazy-
 * fetch via ``GET /v1/events/{id}/content`` on expand. When
 * ``capture_prompts=false`` for the deployment, the previews
 * collapse to the standard "Prompt capture is not enabled" copy
 * (Rule 21 disabled-state contract).
 *
 * The SPAWNED FROM section also surfaces the parent → child INPUT
 * and child → parent OUTPUT for the *current* child session
 * (mirrors what the parent view shows for that session).
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
  // ``session.capture_enabled`` is computed by the API as EXISTS
  // event with has_content=true, which doesn't reflect D126 § 6
  // cross-agent message capture (messages ride on session_start /
  // session_end payloads inline; only the >8 KiB overflow path
  // sets has_content=true). Treat the SubAgentsTab as
  // capture-enabled when EITHER the API flag fires OR any of this
  // session's events carries an incoming/outgoing message body.
  // The Rule 21 disabled state still fires when neither condition
  // holds — e.g., a root session with capture_prompts=false and no
  // sub-agent linkage.
  const hasAnyMessageBody = useMemo(
    () =>
      events.some(
        (e) =>
          e.event_type === "session_start" &&
          !!e.payload?.incoming_message,
      ) ||
      events.some(
        (e) =>
          e.event_type === "session_end" &&
          !!e.payload?.outgoing_message,
      ),
    [events],
  );
  const captureEnabled = session.capture_enabled === true || hasAnyMessageBody;

  // session_start carries this session's incoming_message; session_end
  // carries outgoing_message. Used for the SPAWNED FROM section's
  // own-side preview when this session is a child.
  const ownIncoming = useMemo(() => {
    const e = events.find((x) => x.event_type === "session_start");
    return e?.payload?.incoming_message
      ? { event: e, message: e.payload.incoming_message }
      : null;
  }, [events]);
  const ownOutgoing = useMemo(() => {
    const e = events.find((x) => x.event_type === "session_end");
    return e?.payload?.outgoing_message
      ? { event: e, message: e.payload.outgoing_message }
      : null;
  }, [events]);

  return (
    <div
      className="flex flex-col gap-4 p-3"
      data-testid="sub-agents-tab-content"
    >
      {isChild && session.parent_session_id && (
        <SpawnedFromSection
          parentSessionId={session.parent_session_id}
          captureEnabled={captureEnabled}
          ownIncoming={ownIncoming}
          ownOutgoing={ownOutgoing}
          onOpenSession={onOpenSession}
        />
      )}
      <SubAgentsSection
        sessionId={session.session_id}
        captureEnabled={captureEnabled}
        onOpenSession={onOpenSession}
      />
    </div>
  );
}

/* ---------------- SPAWNED FROM ---------------- */

function SpawnedFromSection({
  parentSessionId,
  captureEnabled,
  ownIncoming,
  ownOutgoing,
  onOpenSession,
}: {
  parentSessionId: string;
  captureEnabled: boolean;
  ownIncoming: { event: AgentEvent; message: SubagentMessage } | null;
  ownOutgoing: { event: AgentEvent; message: SubagentMessage } | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const [parent, setParent] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    let cancelled = false;
    fetchSession(parentSessionId, 1)
      .then((d) => {
        if (!cancelled) setParent(d.session);
      })
      .catch(() => {
        if (!cancelled) setParent(null);
      })
      .finally(() => {
        setLoading(false);
      });
    return () => {
      cancelled = true;
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
        <>
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
          {/* INPUT received from parent + OUTPUT sent back. Both
              sourced from this session's own session_start /
              session_end payloads. capture_enabled=false collapses
              to the disabled-state copy per Rule 21. */}
          {!captureEnabled && (
            <RowEmpty>
              Prompt capture is not enabled for this deployment.
            </RowEmpty>
          )}
          {captureEnabled && ownIncoming && (
            <MessagePreview
              label="Input from parent"
              eventId={ownIncoming.event.id}
              message={ownIncoming.message}
              testId="sub-agents-own-input"
            />
          )}
          {captureEnabled && ownOutgoing && (
            <MessagePreview
              label="Output to parent"
              eventId={ownOutgoing.event.id}
              message={ownOutgoing.message}
              testId="sub-agents-own-output"
            />
          )}
        </>
      )}
    </Section>
  );
}

/* ---------------- SUB-AGENTS ---------------- */

function SubAgentsSection({
  sessionId,
  captureEnabled,
  onOpenSession,
}: {
  sessionId: string;
  captureEnabled: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  const [children, setChildren] = useState<SessionListItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchSessions({ parent_session_id: sessionId, limit: 100 })
      .then((r) => {
        if (!cancelled) setChildren(r.sessions);
      })
      .catch(() => {
        if (!cancelled) setChildren([]);
      });
    return () => {
      cancelled = true;
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
          gap: 6,
          listStyle: "none",
          padding: 0,
          margin: 0,
        }}
      >
        {children.map((c) => (
          <li key={c.session_id}>
            <ChildRow
              child={c}
              captureEnabled={captureEnabled}
              onOpenSession={onOpenSession}
            />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ChildRow({
  child,
  captureEnabled,
  onOpenSession,
}: {
  child: SessionListItem;
  captureEnabled: boolean;
  onOpenSession: (sessionId: string) => void;
}) {
  // Per-child detail loaded on first expand. Carries the child's
  // session_start (incoming_message) + session_end (outgoing_message)
  // so the previews render off the same payload shape the parent
  // view above uses for its own session.
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded || detail !== null) return;
    setLoading(true);
    let cancelled = false;
    fetchSession(child.session_id)
      .then((d) => {
        if (!cancelled) setDetail(d);
      })
      .catch(() => {
        if (!cancelled) {
          setDetail({ session: child as unknown as Session, events: [] });
        }
      })
      .finally(() => {
        // Clear loading unconditionally — see MessagePreview for
        // the same React-18-strict-mode rationale.
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, detail, child.session_id, child]);

  const incoming = detail?.events.find((e) => e.event_type === "session_start")
    ?.payload?.incoming_message;
  const incomingEvent = detail?.events.find((e) => e.event_type === "session_start");
  const outgoing = detail?.events.find((e) => e.event_type === "session_end")
    ?.payload?.outgoing_message;
  const outgoingEvent = detail?.events.find((e) => e.event_type === "session_end");

  return (
    <div
      data-testid={`sub-agents-child-${child.session_id}`}
      style={{
        border: "1px solid var(--border)",
        borderRadius: 6,
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "6px 10px",
          background: expanded ? "var(--bg-elevated)" : "transparent",
        }}
      >
        <button
          type="button"
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={() => setExpanded((v) => !v)}
          data-testid={`sub-agents-child-toggle-${child.session_id}`}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: 0,
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 3,
            background: "color-mix(in srgb, var(--accent) 12%, transparent)",
            color: "var(--accent)",
            flexShrink: 0,
          }}
        >
          {child.agent_role ?? "(role unknown)"}
        </span>
        <button
          type="button"
          onClick={() => onOpenSession(child.session_id)}
          data-testid={`sub-agents-child-open-${child.session_id}`}
          style={{
            background: "transparent",
            border: "none",
            cursor: "pointer",
            color: "var(--text)",
            fontSize: 12,
            padding: 0,
            flex: 1,
            textAlign: "left",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            textDecoration: "underline",
            textDecorationColor:
              "color-mix(in srgb, var(--accent) 40%, transparent)",
          }}
        >
          {truncateSessionId(child.session_id)}
        </button>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {child.state}
        </span>
        {child.state === "lost" && (
          <SubAgentLostDot
            role={child.agent_role ?? undefined}
            sessionIdSuffix={child.session_id.slice(-8)}
            testId={`sub-agents-child-lost-dot-${child.session_id}`}
          />
        )}
      </div>
      {expanded && (
        <div
          style={{
            padding: "8px 10px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            borderTop: "1px solid var(--border-subtle)",
            background: "var(--surface)",
          }}
        >
          {!captureEnabled && (
            <RowEmpty>
              Prompt capture is not enabled for this deployment.
            </RowEmpty>
          )}
          {captureEnabled && loading && <RowEmpty>Loading…</RowEmpty>}
          {captureEnabled && !loading && incoming && incomingEvent && (
            <MessagePreview
              label="Input"
              eventId={incomingEvent.id}
              message={incoming}
              testId={`sub-agents-child-input-${child.session_id}`}
            />
          )}
          {captureEnabled && !loading && outgoing && outgoingEvent && (
            <MessagePreview
              label="Output"
              eventId={outgoingEvent.id}
              message={outgoing}
              testId={`sub-agents-child-output-${child.session_id}`}
            />
          )}
          {captureEnabled && !loading && !incoming && !outgoing && (
            <RowEmpty>No messages captured for this sub-agent.</RowEmpty>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- MESSAGE preview ---------------- */

const PREVIEW_CHARS = 200;

/**
 * Coerce the wire-level ``body`` (polymorphic per framework — the
 * worker stores a string for Claude Code Task subagent prompts and
 * a dict / list for CrewAI / LangGraph state) into a renderable
 * string. Plain strings pass through; structured shapes are JSON-
 * formatted so the operator can read the underlying data without
 * losing the source detail.
 */
function bodyToString(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  return JSON.stringify(body, null, 2);
}

function bodyByteSize(message: SubagentMessage): number {
  if (message.has_content && typeof message.content_bytes === "number") {
    return message.content_bytes;
  }
  const inline = bodyToString(message.body);
  return inline.length;
}

function MessagePreview({
  label,
  message,
  eventId,
  testId,
}: {
  label: string;
  message: SubagentMessage;
  eventId: string;
  testId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [overflowBody, setOverflowBody] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Lazy-fetch the overflow body only on expand. Inline messages
  // (has_content=false) skip this entirely; the inline string is
  // already in ``message.message``. The 200-char preview always
  // truncates from the inline copy when present, falling back to
  // the fetched body when the inline is empty (overflow case
  // pre-expand).
  //
  // No ``alive`` cleanup flag — under React 18 strict mode the
  // double-invoke pattern would set ``alive = false`` on the first
  // cleanup, dropping the .finally setLoading(false) for the first
  // fetch. The second invocation's fetch eventually fires but the
  // visible state was momentarily stuck on "Loading…", which broke
  // the unit test environment. Letting both writes land is benign
  // — the second one wins, and React's strict-mode contract is
  // explicitly that effects must be idempotent under double-invoke.
  useEffect(() => {
    if (!expanded || !message.has_content || overflowBody !== null) return;
    setLoading(true);
    let cancelled = false;
    fetchEventContent(eventId)
      .then((c) => {
        if (cancelled) return;
        const raw = c?.input;
        const text =
          typeof raw === "string"
            ? raw
            : raw == null
              ? ""
              : JSON.stringify(raw, null, 2);
        setOverflowBody(text);
      })
      .catch(() => {
        if (!cancelled) setOverflowBody("");
      })
      .finally(() => {
        // Always clear loading, even if cancelled — the alternative
        // strands the spinner on a remounted component whose state
        // is otherwise current.
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, message.has_content, eventId, overflowBody]);

  // Inline body when small; overflow placeholder otherwise. The
  // preview is whichever string we have, truncated. The wire
  // shape's ``body`` is polymorphic (string | object); coerce
  // through bodyToString so previews render readably regardless
  // of the source framework.
  const inlineBody = bodyToString(message.body);
  const fullBody = message.has_content
    ? overflowBody ?? ""
    : inlineBody;
  const previewBody = inlineBody.slice(0, PREVIEW_CHARS);
  const previewIsTruncated =
    !!message.has_content || inlineBody.length > PREVIEW_CHARS;
  const sizeBytes = bodyByteSize(message);

  return (
    <div
      data-testid={testId}
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: 4,
        padding: 6,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color: "var(--text-muted)",
          marginBottom: 4,
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
          {sizeBytes.toLocaleString()} bytes
          {message.has_content && " · overflow"}
        </span>
        {previewIsTruncated && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            data-testid={`${testId}-expand`}
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: "none",
              color: "var(--accent)",
              cursor: "pointer",
              fontSize: 11,
              padding: 0,
              textTransform: "none",
              letterSpacing: 0,
              fontWeight: 500,
            }}
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
        )}
      </div>
      <pre
        style={{
          margin: 0,
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          background: "var(--bg)",
          padding: 6,
          borderRadius: 3,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          maxHeight: expanded ? 400 : 80,
          overflowY: "auto",
          color: "var(--text)",
        }}
      >
        {expanded
          ? loading
            ? "Loading…"
            : fullBody || previewBody || "(empty)"
          : previewBody || (message.has_content ? "(overflow — expand to load)" : "(empty)")}
      </pre>
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
