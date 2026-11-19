import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { EventTypePill } from "@/components/facets/EventTypePill";
import { LiveFeed } from "@/components/fleet/LiveFeed";
import { EventDetailDrawer } from "@/components/fleet/EventDetailDrawer";
import { FleetPanel } from "@/components/fleet/FleetPanel";
import { SurroundingEventsList } from "@/components/events/SurroundingEventsList";
import { EventRow, StreamingPill } from "@/components/session/EventRow";
import { PromptsTab, SessionDrawer } from "@/components/session/SessionDrawer";
import { MCPPolicyEntryTable } from "@/components/policy/MCPPolicyEntryTable";
import { attachBadge, eventBadgeConfig, getBadge } from "@/lib/events";
import type { AgentEvent, FeedEvent, MCPPolicyEntry, Session } from "@/lib/types";

// Every place an event-type badge or an MCP policy decision pill is
// drawn, its markup byte for byte: EventTypePill (the Events page, the
// run drawer's Timeline rows, the agent drawer), the Live feed's badge,
// the event drawer's header chip, the run drawer's attach pill and its
// rows' STREAM / ABORTED badge, the Neighbors list, the Fleet sidebar's
// policy events, the run drawer's event detail header and its Prompts
// list, and the policy table's decision pills, for every event type.
// fixtures/badge-sites-pinned-before-badge-text.json holds the markup as
// main drew it, each label in its hue (captured again from main's
// sources once the Prompts list listed embeddings calls, and with the
// streaming badge added). The labels now take a text shade of the hue
// (BadgeConfig.textVar, and each pill's family's badge text token), and
// nothing else moved: each pinned badge, with its label's colour (and
// only that) swapped for the new one, is the markup rendered now. Set
// CAPTURE_PINNED_MARKUP=1 to write that file again, only for a change
// meant to alter this markup, and check its diff.

const PINNED_FILE = resolve(__dirname, "fixtures/badge-sites-pinned-before-badge-text.json");
const CAPTURE = process.env.CAPTURE_PINNED_MARKUP === "1";

const fetchBulkEvents = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  fetchBulkEvents,
  fetchEventContent: vi.fn(() => Promise.resolve(null)),
  fetchSession: vi.fn(() => Promise.resolve({ session: null, events: [], attachments: [] })),
  fetchSessions: vi.fn(() => Promise.resolve({ sessions: [], total: 0, limit: 1, offset: 0, has_more: false })),
  fetchOlderEvents: vi.fn(() => Promise.resolve({ events: [], total: 0, limit: 50, offset: 0, has_more: false })),
}));

const RUN = "s-badges-0001";
const RUN_SESSION = {
  session_id: RUN,
  flavor: "badges",
  agent_type: "production",
  host: "h",
  framework: null,
  model: null,
  state: "active",
  started_at: "2026-11-19T08:00:00Z",
  last_seen_at: "2026-11-19T08:05:00Z",
  ended_at: null,
  tokens_used: 0,
  token_limit: null,
  has_pending_directive: false,
  capture_prompts: true,
  capture_enabled: true,
};

vi.mock("@/hooks/useSession", () => ({
  useSession: (id: string | null) =>
    id ? { data: { session: RUN_SESSION, events: [], attachments: [] }, loading: false, error: null } : { data: null, loading: false, error: null },
  invalidateSessionCache: vi.fn(),
}));

vi.mock("@/store/fleet", () => ({
  useFleetStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({ customDirectives: [], shuttingDown: new Set<string>(), markShuttingDown: () => {} }),
    { subscribe: () => () => {} },
  ),
}));

beforeEach(() => {
  fetchBulkEvents.mockReset();
  // A focused Prompts-list row scrolls itself into view; jsdom has no layout.
  Element.prototype.scrollIntoView ??= vi.fn();
});

/** Every event type with a badge of its own, and one without (the
 *  default badge). */
const EVENT_TYPES = [...Object.keys(eventBadgeConfig), "an_unknown_type"];
/** The types the run drawer's Prompts list lists. */
const PROMPTS_LIST_TYPES = ["post_call", "tool_call", "mcp_tool_call", "mcp_prompt_get", "embeddings"];

function event(eventType: string, i: number): AgentEvent {
  return {
    id: `ev-${eventType}`,
    session_id: RUN,
    flavor: "badges",
    event_type: eventType,
    model: "gpt-4o-mini",
    tokens_input: 10,
    tokens_output: 5,
    tokens_total: 15,
    latency_ms: 100,
    tool_name: "lookup",
    has_content: true,
    occurred_at: `2026-11-19T08:00:${String(i).padStart(2, "0")}Z`,
    payload: {},
  } as unknown as AgentEvent;
}
const EVENTS = EVENT_TYPES.map(event);

function entry(id: string, fields: Partial<MCPPolicyEntry>): MCPPolicyEntry {
  return {
    id,
    policy_id: "policy-1",
    server_url: "https://maps.example.com",
    server_name: "maps",
    fingerprint: "abcdef0123456789".repeat(4),
    entry_kind: "allow",
    enforcement: null,
    created_at: "2026-05-05T00:00:00Z",
    ...fields,
  };
}

const PILL_ENTRIES = [
  entry("allow", { entry_kind: "allow" }),
  entry("warn", { entry_kind: "deny", enforcement: "warn" }),
  entry("block", { entry_kind: "deny", enforcement: "block" }),
  entry("interactive", { entry_kind: "deny", enforcement: "interactive" }),
];

/** The badge an element's label belongs to: its event type's. */
function byLabel(elements: Element[], site: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of elements) {
    const type = EVENT_TYPES.find((t) => getBadge(t).label === el.textContent);
    if (!type) throw new Error(`${site}: no event type labelled ${el.textContent}`);
    out[`${site}:${type}`] = el.outerHTML;
  }
  return out;
}

/** The span that draws ``label`` as a badge under ``root``. */
function chip(root: Element, label: string): Element {
  const found = Array.from(root.querySelectorAll("span")).filter(
    (s) => s.textContent === label && s.className.includes("min-w-[88px]"),
  );
  expect(found, label).toHaveLength(1);
  return found[0]!;
}

/** Every site's badges, keyed ``site:event type`` (``pill:<kind>`` for
 *  the decision pills), as outerHTML. */
async function markups(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  for (const type of EVENT_TYPES) {
    const { container } = render(<EventTypePill eventType={type} />);
    out[`EventTypePill:${type}`] = container.firstElementChild!.outerHTML;
    cleanup();
  }

  for (const [i, type] of EVENT_TYPES.entries()) {
    const { container } = render(
      <EventRow event={event(type, i)} isExpanded={false} onToggleExpand={() => {}} />,
    );
    out[`EventRow:${type}`] = container.querySelector('[data-testid="event-type-pill"]')!.outerHTML;
    cleanup();
  }
  {
    const { container } = render(
      <EventRow event={event("session_start", 0)} isAttachment isExpanded={false} onToggleExpand={() => {}} />,
    );
    const pill = container.querySelector('[data-testid="event-type-pill"]')!;
    expect(pill.textContent).toBe(attachBadge.label);
    out["EventRow:attach"] = pill.outerHTML;
    cleanup();
  }
  for (const outcome of ["completed", "aborted"] as const) {
    const streamed = {
      ...event("post_call", 0),
      id: `ev-stream-${outcome}`,
      payload: { streaming: { final_outcome: outcome, ttft_ms: 120, chunk_count: 12 } },
    } as unknown as AgentEvent;
    const { container } = render(<StreamingPill event={streamed} />);
    out[`StreamingPill:${outcome}`] = container.firstElementChild!.outerHTML;
    cleanup();
  }

  {
    const feed: FeedEvent[] = EVENTS.map((e, i) => ({ arrivedAt: 1_700_000_000_000 + i, event: e }));
    const { container } = render(<LiveFeed events={feed} onEventClick={() => {}} />);
    Object.assign(out, byLabel(Array.from(container.querySelectorAll('[data-testid="feed-badge"]')), "LiveFeed"));
    cleanup();
  }

  for (const e of EVENTS) {
    render(<EventDetailDrawer event={e} onClose={() => {}} />);
    out[`EventDetailDrawer:${e.event_type}`] = screen.getByTestId("detail-badge").outerHTML;
    cleanup();
  }

  for (const e of EVENTS) {
    fetchBulkEvents.mockResolvedValue({ events: [e], total: 1, has_more: false });
    render(<SurroundingEventsList event={e} onSelect={() => {}} />);
    const anchor = await screen.findByTestId("surrounding-anchor");
    out[`SurroundingEventsList:${e.event_type}`] = anchor.querySelectorAll("span")[1]!.outerHTML;
    cleanup();
  }

  {
    const feed: FeedEvent[] = EVENTS.map((e, i) => ({ arrivedAt: 1_700_000_000_000 + i, event: e }));
    const { container } = render(<FleetPanel flavors={[]} policyEvents={feed} />);
    for (const row of Array.from(container.querySelectorAll('[data-testid^="policy-event-row-"]'))) {
      const type = row.getAttribute("data-testid")!.slice("policy-event-row-".length);
      const label = row.querySelector("span.font-semibold");
      if (label) out[`FleetPanel:${type}`] = label.outerHTML;
    }
    cleanup();
  }

  for (const e of EVENTS) {
    const { container } = render(
      <SessionDrawer sessionId={RUN} onClose={() => {}} directEventDetail={e} onClearDirectEvent={() => {}} />,
    );
    await waitFor(() => expect(container.querySelector('[data-testid="back-to-session"]')).not.toBeNull());
    out[`SessionDrawer.detail:${e.event_type}`] = chip(container, getBadge(e.event_type).label).outerHTML;
    cleanup();
  }

  {
    const listed = EVENTS.filter((e) => PROMPTS_LIST_TYPES.includes(e.event_type));
    for (const focused of [null, listed[0]!.id]) {
      const { container } = render(
        <PromptsTab
          session={RUN_SESSION as unknown as Session}
          events={listed}
          selectedEventId={null}
          focusedEventId={focused}
          onSelectEvent={() => {}}
        />,
      );
      for (const row of Array.from(container.querySelectorAll('[data-testid^="prompts-row-"]'))) {
        const type = row.getAttribute("data-testid")!.slice("prompts-row-ev-".length);
        out[`SessionDrawer.prompts${focused ? ".focused" : ""}:${type}`] = row.querySelector("span")!.outerHTML;
      }
      cleanup();
    }
  }

  {
    render(
      <MCPPolicyEntryTable
        entries={PILL_ENTRIES}
        mode="allowlist"
        scopeKey="global"
        flavor="global"
        scope="flavor"
        loading={false}
        onAdd={() => {}}
        onEdit={() => {}}
        onDelete={async () => {}}
        onApplied={async () => {}}
      />,
    );
    for (const e of PILL_ENTRIES) out[`pill:${e.id}`] = screen.getByTestId(`mcp-policy-entry-pill-${e.id}`).outerHTML;
    cleanup();
  }
  return out;
}

/** Each pinned label's colour then and now. */
function colourSwap(key: string): { was: string; now: string } {
  const [site, kind] = key.split(":") as [string, string];
  if (site === "pill") {
    return {
      allow: { was: "var(--success, #16a34a)", now: "var(--success-badge-text)" },
      warn: { was: "var(--warning, #d97706)", now: "var(--warning-badge-text)" },
      block: { was: "var(--danger)", now: "var(--danger-badge-text)" },
      interactive: { was: "var(--accent-text)", now: "var(--accent-badge-text)" },
    }[kind]!;
  }
  if (site === "StreamingPill") {
    return kind === "aborted"
      ? { was: "var(--event-error)", now: "var(--danger-badge-text)" }
      : { was: "var(--event-llm)", now: "var(--event-llm-badge-text)" };
  }
  const badge = kind === "attach" ? attachBadge : getBadge(kind);
  return { was: badge.cssVar, now: badge.textVar };
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("every badge and decision pill: only the label's colour moved", () => {
  if (CAPTURE) {
    it("captures the markup", async () => {
      writeFileSync(PINNED_FILE, `${JSON.stringify(await markups(), null, 2)}\n`);
    });
    return;
  }

  const pinned = JSON.parse(readFileSync(PINNED_FILE, "utf8")) as Record<string, string>;

  it("each badge at every site is its pinned markup with the label's colour, and only it, in the badge text shade", async () => {
    const now = await markups();
    // The same badges at every site as when it was pinned.
    expect(Object.keys(now).sort()).toEqual(Object.keys(pinned).sort());
    // Every site is covered: the decision pills, the streaming badge and
    // the event-type badge sites.
    const sites = new Set(Object.keys(pinned).map((k) => k.split(":")[0]));
    expect([...sites].sort()).toEqual([
      "EventDetailDrawer",
      "EventRow",
      "EventTypePill",
      "FleetPanel",
      "LiveFeed",
      "SessionDrawer.detail",
      "SessionDrawer.prompts",
      "SessionDrawer.prompts.focused",
      "StreamingPill",
      "SurroundingEventsList",
      "pill",
    ]);

    const failures: string[] = [];
    for (const [key, html] of Object.entries(pinned)) {
      const { was, now: shade } = colourSwap(key);
      const label = new RegExp(`(^|[\\s;"])color: ${escape(was)};`, "g");
      const matches = html.match(label) ?? [];
      if (matches.length !== 1) {
        failures.push(`${key}: the pinned markup draws its label in ${was} ${matches.length} times`);
        continue;
      }
      const expected = html.replace(label, `$1color: ${shade};`);
      if (now[key] !== expected) failures.push(`${key}:\n  expected ${expected}\n  rendered ${now[key]}`);
    }
    expect(failures, failures.slice(0, 5).join("\n")).toEqual([]);
  });
});
