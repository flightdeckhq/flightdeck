import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { AgentEvent, Session, SessionDetail, SessionListItem, SubagentMessage } from "@/lib/types";
import { fetchEventContent, fetchSession, fetchSessions } from "@/lib/api";
import { truncateSessionId } from "@/lib/events";
import { SubAgentLostDot } from "@/components/facets/SubAgentRolePill";
import { EventRow } from "./EventRow";
import type { DrawerTab } from "./SessionDrawer";

// D126 UX revision (post-merge polish, pre-merge land) — cap on the
// inline mini-timeline rendered when a related-session row is
// chevron-expanded inside the Sub-agents tab. Above this many events
// we render the first N and a "View N more in Timeline tab"
// affordance that navigates to the related session's drawer (whose
// default tab is Timeline). 12 sits comfortably between "shows
// enough activity to gauge what the sub-agent did" and "doesn't
// turn the parent's drawer into a vertical scroll fight". The
// supervisor's spec gave 10–15 as the acceptable range.
const MINI_TIMELINE_MAX_EVENTS = 12;

// Investigate PARENT-column link styling (Investigate.tsx:2410-2437)
// reused on every session-id navigation affordance in this tab so
// the visual cue stays consistent with the page-level pattern. The
// chevron toggle is intentionally a different visual class — it's
// a row-control, not a navigation link.
const SESSION_ID_LINK_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--accent)",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: 0,
  textDecoration: "underline",
  textDecorationColor:
    "color-mix(in srgb, var(--accent) 40%, transparent)",
};

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
   *  current view. The optional `tab` arg routes the rebound drawer
   *  to a specific tab — used by the mini-timeline "View N more in
   *  Timeline tab" footer to land the user on Timeline rather than
   *  whatever tab they came from. Without it the drawer keeps the
   *  current tab (Sub-agents). */
  onOpenSession: (sessionId: string, tab?: DrawerTab) => void;
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
  onOpenSession: (sessionId: string, tab?: DrawerTab) => void;
}) {
  // The header card carries minimal session metadata regardless of
  // whether the row is expanded — agent_name + truncated id + state.
  // Expanding fetches the parent's recent events (capped at the
  // mini-timeline limit) so the inline preview shows what the
  // parent has been doing without forcing the user to navigate
  // away from this drawer.
  const [parent, setParent] = useState<Session | null>(null);
  const [parentEvents, setParentEvents] = useState<AgentEvent[] | null>(null);
  const [headerLoading, setHeaderLoading] = useState(true);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Fetch the parent header (just the session row; events stay
  // unfetched until the user expands the card so we don't pay the
  // events-list cost up front).
  useEffect(() => {
    setHeaderLoading(true);
    let cancelled = false;
    fetchSession(parentSessionId, 1)
      .then((d) => {
        if (!cancelled) setParent(d.session);
      })
      .catch(() => {
        if (!cancelled) setParent(null);
      })
      .finally(() => {
        setHeaderLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [parentSessionId]);

  // Lazy-fetch parent events on first expand. Cached for the
  // lifetime of this component instance so collapse → re-expand
  // doesn't re-fetch.
  useEffect(() => {
    if (!expanded || parentEvents !== null) return;
    setEventsLoading(true);
    let cancelled = false;
    fetchSession(parentSessionId)
      .then((d) => {
        if (!cancelled) setParentEvents(d.events);
      })
      .catch(() => {
        if (!cancelled) setParentEvents([]);
      })
      .finally(() => {
        // Always clear loading even if cancelled — see MessagePreview
        // for the React-18-strict-mode rationale on this pattern.
        setEventsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, parentEvents, parentSessionId]);

  return (
    <Section title="Spawned from" testId="sub-agents-spawned-from">
      {headerLoading && <RowEmpty>Loading parent run…</RowEmpty>}
      {!headerLoading && !parent && (
        <RowEmpty>
          Parent run{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>
            {truncateSessionId(parentSessionId)}
          </code>{" "}
          is not yet known. The platform writes a stub when a child
          arrives ahead of its parent; the row will populate once the
          parent's session_start lands.
        </RowEmpty>
      )}
      {!headerLoading && parent && (
        <ExpandableSessionCard
          headerTestId="sub-agents-spawned-from-card"
          expanded={expanded}
          onToggleExpand={() => setExpanded((v) => !v)}
          onOpenSession={() => onOpenSession(parent.session_id)}
          sessionIdLinkTestId="sub-agents-spawned-from-link"
          chevronToggleTestId="sub-agents-spawned-from-toggle"
          identifier={
            <span
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
            </span>
          }
          sessionIdLabel={truncateSessionId(parent.session_id)}
          state={parent.state}
        >
          {/* Inline-expanded body: summary metrics, mini-timeline,
              and existing IN/OUT messages from this child's own
              session_start / session_end payloads. The mini-timeline
              gives the user a view of recent parent activity without
              leaving this drawer; clicking the session-id link in
              the header navigates to the parent's drawer for the
              full Timeline / Prompts / Directives tabs. */}
          <ExpansionMetricsSummary
            session={parent}
            events={parentEvents ?? []}
            loading={eventsLoading}
          />
          <EventMiniTimeline
            events={parentEvents ?? []}
            loading={eventsLoading}
            onViewMore={() => onOpenSession(parent.session_id, "timeline")}
            testIdPrefix="sub-agents-spawned-from"
          />
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
        </ExpandableSessionCard>
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
  onOpenSession: (sessionId: string, tab?: DrawerTab) => void;
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

/* ---------------- shared expansion chrome ---------------- */

/**
 * Two-affordance row used by both SpawnedFromSection and ChildRow.
 *
 *   * Left chevron button — toggles inline expansion. Hover state on
 *     the chevron only; click does NOT navigate.
 *   * Right session-id button — link-styled (Investigate PARENT
 *     column visual; ``var(--accent)`` colour, underlined). Click
 *     calls ``onOpenSession`` to rebind the drawer.
 *
 * The two affordances do NOT overlap. Clicking the chevron never
 * navigates; clicking the session id never expands. This is the
 * supervisor's UX revision contract — pre-fix the SpawnedFrom
 * section was a single monolithic button that navigated on any
 * click, which read as expand-affordance to users (the chevron
 * looked like a tree-toggle) but behaved as navigation.
 */
function ExpandableSessionCard({
  headerTestId,
  expanded,
  onToggleExpand,
  onOpenSession,
  sessionIdLinkTestId,
  chevronToggleTestId,
  identifier,
  sessionIdLabel,
  state,
  trailing,
  children,
}: {
  headerTestId: string;
  expanded: boolean;
  onToggleExpand: () => void;
  onOpenSession: () => void;
  sessionIdLinkTestId: string;
  chevronToggleTestId: string;
  identifier: React.ReactNode;
  sessionIdLabel: string;
  state: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      data-testid={headerTestId}
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
          aria-expanded={expanded}
          onClick={onToggleExpand}
          data-testid={chevronToggleTestId}
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
        <span style={{ flex: 1, minWidth: 0 }}>{identifier}</span>
        <button
          type="button"
          onClick={onOpenSession}
          data-testid={sessionIdLinkTestId}
          title="Open this run in the drawer"
          style={SESSION_ID_LINK_STYLE}
        >
          {sessionIdLabel}
        </button>
        <span
          style={{
            fontSize: 11,
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
          }}
        >
          {state}
        </span>
        {trailing}
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
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Compact summary line shown at the top of every expanded row:
 * total tokens, LLM call count, tool call count. Computed from the
 * session's events (when fetched) — falls back to the session
 * row's ``tokens_used`` rollup for the token total when events are
 * still loading or absent. The supervisor explicitly noted that
 * pre-219a5c0a sub-agents have only session_start + session_end
 * events; this component renders "0 LLM calls / 0 tool calls" for
 * those, which is correct historical data, not a bug.
 */
function ExpansionMetricsSummary({
  session,
  events,
  loading,
}: {
  session: Session | null;
  events: AgentEvent[];
  loading: boolean;
}) {
  const llmCalls = events.filter((e) => e.event_type === "post_call").length;
  const toolCalls = events.filter((e) => e.event_type === "tool_call").length;
  const eventTokens = events.reduce(
    (acc, e) => acc + (e.tokens_total ?? 0),
    0,
  );
  // Prefer the session-row rollup when we have it (covers post-call
  // events the events listing may have paginated past); fall back to
  // the events-array sum when the row's tokens_used is 0 / missing
  // so the summary still renders something useful when the session
  // row hasn't loaded yet OR the rollup hasn't caught up to the
  // event stream. ``||`` (not ``??``) so a 0 rollup falls through
  // — a session with non-zero events shouldn't show 0 tokens.
  const tokens = session?.tokens_used || eventTokens;

  return (
    <div
      data-testid="sub-agents-expansion-metrics"
      style={{
        display: "flex",
        gap: 12,
        fontSize: 11,
        color: "var(--text-muted)",
        fontFamily: "var(--font-mono)",
      }}
    >
      <span>
        <strong style={{ color: "var(--text)" }}>
          {tokens.toLocaleString()}
        </strong>{" "}
        tokens
      </span>
      <span>
        <strong style={{ color: "var(--text)" }}>{llmCalls}</strong> LLM call
        {llmCalls === 1 ? "" : "s"}
      </span>
      <span>
        <strong style={{ color: "var(--text)" }}>{toolCalls}</strong> tool call
        {toolCalls === 1 ? "" : "s"}
      </span>
      {loading && (
        <span style={{ fontStyle: "italic" }}>loading events…</span>
      )}
    </div>
  );
}

/**
 * Capped event list rendered inside a row's expanded body. Renders
 * up to MINI_TIMELINE_MAX_EVENTS most recent events using the same
 * ``EventDetail`` component the full Timeline tab uses, so visual
 * patterns and click-to-expand behaviour stay consistent. When the
 * session has more events than the cap, a "View N more in Timeline
 * tab" footer link calls ``onViewMore`` (which navigates to the
 * related session via ``onOpenSession`` — the drawer opens on
 * Timeline by default).
 */
function EventMiniTimeline({
  events,
  loading,
  onViewMore,
  testIdPrefix,
}: {
  events: AgentEvent[];
  loading: boolean;
  onViewMore: () => void;
  testIdPrefix: string;
}) {
  // Per the D126 UX revision (DECISIONS.md "UX revision
  // 2026-05-04"), the mini-timeline must render with EXACT
  // Timeline-tab fidelity — colour-pill badges, streaming
  // indicators, MCP error indicators, provider logos, expand-
  // into-ExpandedEvent on click — same as the full Timeline tab.
  // Sharing the ``EventRow`` component (which the SessionDrawer's
  // own EventFeed also uses) is the load-bearing piece of that
  // contract; future row-shape changes land in both places
  // without manual sync.
  //
  // Per-row expansion state is tracked here (one event open at a
  // time) so the user can click any row to drill into details
  // without leaving the parent's drawer. ``attachments`` is
  // empty by default — the inline mini-timeline doesn't have
  // access to the related session's attachment timestamps. The
  // ATTACH-circle recolouring is a Timeline-tab-only affordance
  // for now; the supervisor's spec explicitly listed badges +
  // streaming/MCP indicators + provider logos, not attach
  // recolouring, so this divergence is acceptable.
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  // Always wrap in the testid'd container so callers (tests and
  // the parent layout) can target the mini-timeline regardless of
  // whether events have loaded yet — empty / loading states are
  // legitimate post-D126 shapes (pre-219a5c0a sub-agents have
  // only session_start + session_end events; those still render
  // as 2 EventRows, accurate historical data per the supervisor's
  // explicit note).
  //
  // Order: newest-first (DESC by occurred_at) to match the main
  // Timeline tab's order. The API returns events ASC; we sort on
  // the client so a slice picks the most recent N — what the user
  // wants to see when peeking at recent activity without leaving
  // the parent's drawer.
  const sorted = useMemo(
    () =>
      [...events].sort((a, b) =>
        b.occurred_at.localeCompare(a.occurred_at),
      ),
    [events],
  );
  const visible = sorted.slice(0, MINI_TIMELINE_MAX_EVENTS);
  const hidden = Math.max(0, sorted.length - visible.length);
  return (
    <div
      data-testid={`${testIdPrefix}-mini-timeline`}
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: 4,
        overflow: "hidden",
      }}
    >
      {visible.length === 0 && loading && (
        <RowEmpty>Loading recent events…</RowEmpty>
      )}
      {visible.length === 0 && !loading && (
        <RowEmpty>No events recorded for this session.</RowEmpty>
      )}
      {visible.map((e) => (
        <EventRow
          key={e.id}
          event={e}
          attachments={[]}
          isExpanded={expandedEventId === e.id}
          onToggleExpand={(id) =>
            setExpandedEventId((prev) => (prev === id ? null : id))
          }
        />
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={onViewMore}
          data-testid={`${testIdPrefix}-mini-timeline-view-more`}
          style={{
            display: "block",
            width: "100%",
            textAlign: "center",
            padding: "6px 10px",
            background: "transparent",
            border: "none",
            borderTop: "1px solid var(--border-subtle)",
            color: "var(--accent)",
            fontSize: 11,
            cursor: "pointer",
          }}
        >
          View {hidden} more in Timeline tab →
        </button>
      )}
    </div>
  );
}

function ChildRow({
  child,
  captureEnabled,
  onOpenSession,
}: {
  child: SessionListItem;
  captureEnabled: boolean;
  onOpenSession: (sessionId: string, tab?: DrawerTab) => void;
}) {
  // Per-child detail loaded on first expand. Carries the child's
  // session_start (incoming_message) + session_end (outgoing_message)
  // so the previews render off the same payload shape the parent
  // view above uses for its own session AND the events list that
  // drives the inline mini-timeline + metrics summary.
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

  const events = detail?.events ?? [];
  const incoming = events.find((e) => e.event_type === "session_start")
    ?.payload?.incoming_message;
  const incomingEvent = events.find((e) => e.event_type === "session_start");
  const outgoing = events.find((e) => e.event_type === "session_end")
    ?.payload?.outgoing_message;
  const outgoingEvent = events.find((e) => e.event_type === "session_end");

  return (
    <ExpandableSessionCard
      headerTestId={`sub-agents-child-${child.session_id}`}
      expanded={expanded}
      onToggleExpand={() => setExpanded((v) => !v)}
      onOpenSession={() => onOpenSession(child.session_id)}
      sessionIdLinkTestId={`sub-agents-child-open-${child.session_id}`}
      chevronToggleTestId={`sub-agents-child-toggle-${child.session_id}`}
      identifier={
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
      }
      sessionIdLabel={truncateSessionId(child.session_id)}
      state={child.state}
      trailing={
        child.state === "lost" ? (
          <SubAgentLostDot
            role={child.agent_role ?? undefined}
            sessionIdSuffix={child.session_id.slice(-8)}
            testId={`sub-agents-child-lost-dot-${child.session_id}`}
          />
        ) : undefined
      }
    >
      {/* W consolidation — when chevron-expanded, show summary
          metrics + mini-timeline + IN/OUT messages all together so
          the user sees what the sub-agent did without leaving the
          parent's drawer. The session-id link in the header
          handles "navigate to this sub-agent's full drawer" for
          deeper inspection (Timeline / Prompts / Directives tabs). */}
      <ExpansionMetricsSummary
        session={detail?.session ?? null}
        events={events}
        loading={loading}
      />
      <EventMiniTimeline
        events={events}
        loading={loading}
        onViewMore={() => onOpenSession(child.session_id, "timeline")}
        testIdPrefix={`sub-agents-child-${child.session_id}`}
      />
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
    </ExpandableSessionCard>
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
