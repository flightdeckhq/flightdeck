import { useState, useEffect, useCallback } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import { Search, Settings as SettingsIcon, Sun, Moon } from "lucide-react";
import { Fleet } from "@/pages/Fleet";
import { Agents } from "@/pages/Agents";
import { AgentDrawer } from "@/components/agents/AgentDrawer";
import { EventDetailDrawer } from "@/components/fleet/EventDetailDrawer";
import { Policies } from "@/pages/Policies";
import { Directives } from "@/pages/Directives";
import { NotFound } from "@/pages/NotFound";
import { Analytics } from "@/pages/Analytics";
import { Investigate } from "@/pages/Investigate";
import { Settings } from "@/pages/Settings";
import { CommandPalette } from "@/components/search/CommandPalette";
import { fetchBulkEvents } from "@/lib/api";
import type {
  AgentEvent,
  SearchResultAgent,
  SearchResultEvent,
  SearchResultSession,
} from "@/lib/types";
import { useTheme } from "@/hooks/useTheme";

// Named-constant source-of-truth for the navbar lockup image
// paths. Exported so the Nav unit test consumes the same value
// the runtime renders, eliminating the duplicate-magic-string
// drift surface flagged in PR #43 review.
export const LOCKUP_SRC = {
  dark: "/assets/flightdeck-lockup-dark.svg",
  light: "/assets/flightdeck-lockup-light.svg",
} as const;

export function Nav({ onSearchClick }: { onSearchClick: () => void }) {
  const { theme, toggleTheme } = useTheme();
  const lockupSrc = theme === "dark" ? LOCKUP_SRC.dark : LOCKUP_SRC.light;

  return (
    <nav
      className="flex h-[52px] items-center border-b px-4"
      style={{
        background: "var(--surface)",
        borderColor: "var(--border)",
      }}
    >
      <NavLink
        to="/"
        end
        aria-label="Flightdeck, go to Fleet"
        className="flex items-center"
        data-testid="nav-lockup-link"
      >
        {/* Decorative img: the wrapping NavLink's aria-label
            provides the link's accessible name in full. An
            ``alt`` here would duplicate the announcement. */}
        <img
          src={lockupSrc}
          alt=""
          className="h-[44px] w-auto"
          data-testid="nav-lockup"
        />
      </NavLink>

      <div className="ml-8 flex items-center gap-6">
        {[
          { to: "/", label: "Fleet", end: true },
          { to: "/agents", label: "Agents" },
          { to: "/events", label: "Events" },
          { to: "/policies", label: "Policies" },
          { to: "/directives", label: "Directives" },
          { to: "/analytics", label: "Analytics" },
        ].map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.end}
            className={({ isActive }) =>
              `relative pb-[11px] pt-[13px] text-[13px] transition-colors ${
                isActive
                  ? "text-text"
                  : "text-text-secondary hover:text-text"
              }`
            }
            style={({ isActive }) =>
              isActive
                ? { borderBottom: "2px solid var(--accent)" }
                : undefined
            }
          >
            {link.label}
          </NavLink>
        ))}
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          onClick={onSearchClick}
          className="flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-text-muted transition-colors hover:border-primary hover:text-text"
          aria-label="Search"
          data-testid="nav-search-trigger"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Search</span>
          <kbd className="hidden rounded bg-bg-elevated px-1 py-0.5 text-[11px] font-medium sm:inline">
            {navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}K
          </kbd>
        </button>
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            `flex h-8 w-8 items-center justify-center rounded transition-colors hover:bg-surface-hover ${
              isActive ? "text-text" : "text-text-secondary"
            }`
          }
          aria-label="Settings"
          data-testid="nav-settings"
        >
          {({ isActive }) => (
            <SettingsIcon
              size={16}
              style={{
                color: isActive ? "var(--text)" : "var(--text-secondary)",
              }}
            />
          )}
        </NavLink>
        <button
          onClick={toggleTheme}
          className="flex h-8 w-8 items-center justify-center rounded transition-colors hover:bg-surface-hover"
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        >
          {theme === "dark" ? (
            <Moon size={16} style={{ color: "var(--text-secondary)" }} />
          ) : (
            <Sun size={16} style={{ color: "var(--text-secondary)" }} />
          )}
        </button>
      </div>
    </nav>
  );
}

/**
 * Routing helper for the global search modal. Only the session
 * branch returns an href that the palette navigates to — agent
 * and event hits open overlay drawers via URL params on the
 * current route (see CommandPaletteHost) so the operator stays
 * where they were instead of being yanked to /events.
 *
 * Agent + event branches return relative ``?...`` fragments
 * usable from any route. External deep links should prepend a
 * meaningful base route (``/agents?agent_drawer=...`` /
 * ``/events?event=...&event_session=...``) so the underlying
 * page makes sense if the operator closes the drawer.
 */
export function buildSearchResultHref(
  type: "agent" | "session" | "event",
  item: SearchResultAgent | SearchResultSession | SearchResultEvent,
): string {
  if (type === "session") {
    return `/events?run=${encodeURIComponent(
      (item as SearchResultSession).session_id,
    )}`;
  }
  if (type === "agent") {
    // The palette handler now opens the agent drawer overlay via
    // setSearchParams (the new D supersedes F2). This branch is
    // kept for deep-link / bookmark callers that need an href
    // string — same agent_drawer param the in-app overlay uses.
    return `?agent_drawer=${encodeURIComponent(
      (item as SearchResultAgent).agent_id,
    )}`;
  }
  // event — overlay via ?event= + ?event_session=, NOT ?run= (that
  // opens the run drawer; the two would stack).
  const ev = item as SearchResultEvent;
  return `?event=${encodeURIComponent(ev.event_id)}&event_session=${encodeURIComponent(ev.session_id)}`;
}

// Strict RFC-4122 gate for the ``?agent_drawer=`` and ``?event=`` /
// ``?event_session=`` params. Every id the dashboard uses is a v4 or
// v5 UUID; the canonical 8-4-4-4-12 shape (case-insensitive via /i)
// rejects nothing legitimate while a malformed bookmark or crafted
// URL silently no-ops (the drawer stays closed) instead of opening
// on garbage.
const AGENT_DRAWER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Event + session ids share the same shape — intentionally a shared
// reference so a future tightening lands once.
const EVENT_DRAWER_ID_RE = AGENT_DRAWER_ID_RE;

// EventDetailDrawerHost hydration parameters.
//
// 2000 is the api server's ``eventsMaxLimit`` cap (see
// ``api/internal/handlers/events_list.go``). Sessions that exceed
// 2000 events still hit ``has_more=true``; the host surfaces a
// "not found in latest 2000" empty state in that case rather than
// rendering an invisible drawer (architect review).
//
// 1970-01-01 is the lowest ISO timestamp the events filter accepts;
// session-scoped queries don't need a tighter floor because the
// ``session_id`` filter is what narrows the result set.
const EVENT_DRAWER_FETCH_LIMIT = 2000;
const EVENT_DRAWER_FETCH_FROM = "1970-01-01T00:00:00Z";

/**
 * App-level host for the agent drawer. The drawer's open state is
 * the `?agent_drawer=<agent_id>` URL param: a `/agents` row click
 * or a Fleet swimlane agent-name click sets it, a deep link opens
 * the drawer on load, and the browser back button closes it.
 * Mounted once here (outside `<Routes>`) so it opens identically
 * from `/agents` and the Fleet swimlane without per-page wiring.
 */
function AgentDrawerHost() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("agent_drawer");
  const agentId = raw && AGENT_DRAWER_ID_RE.test(raw) ? raw : null;

  // Close replaces the history entry so a closed drawer never sits
  // in the back stack — the browser back button lands on whatever
  // preceded the drawer opening, not on a re-opened drawer.
  const close = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("agent_drawer");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  // Re-pointing the drawer at a linked agent pushes a history entry
  // so back returns to the previous agent's drawer.
  const selectAgent = useCallback(
    (id: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("agent_drawer", id);
        return next;
      });
    },
    [setSearchParams],
  );

  return (
    <AgentDrawer agentId={agentId} onClose={close} onSelectAgent={selectAgent} />
  );
}

/**
 * App-level host for the event detail drawer. Driven by the
 * ``?event=<event_id>&event_session=<session_id>`` URL params; the
 * search palette's event hits set them so the drawer opens as an
 * overlay on the current route instead of yanking the operator to
 * /events. Uses ``?event=`` (a fresh namespace) rather than
 * ``?run=`` so an event-hit click does not also trigger the run
 * drawer Investigate already mounts on ``?run=``.
 *
 * Hydration: a single ``fetchBulkEvents`` call scoped to the
 * session_id (no new endpoint) provides the AgentEvent the
 * drawer needs; the matching event is picked by id. While the
 * fetch is in flight EventDetailDrawer renders null (its prop
 * gate), so there is no half-rendered shell to manage.
 */
function EventDetailDrawerHost() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawEvent = searchParams.get("event");
  const rawSession = searchParams.get("event_session");
  const active =
    rawEvent !== null &&
    rawSession !== null &&
    EVENT_DRAWER_ID_RE.test(rawEvent) &&
    EVENT_DRAWER_ID_RE.test(rawSession);
  const [event, setEvent] = useState<AgentEvent | null>(null);
  // ``notFound`` is true when the fetch returned a page (possibly
  // with has_more) but the target event id was absent. Used to
  // render an explicit empty state rather than an invisible drawer.
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!active || !rawSession || !rawEvent) {
      setEvent(null);
      setNotFound(false);
      return;
    }
    const controller = new AbortController();
    setNotFound(false);
    fetchBulkEvents(
      {
        from: EVENT_DRAWER_FETCH_FROM,
        session_id: rawSession,
        limit: EVENT_DRAWER_FETCH_LIMIT,
      },
      controller.signal,
    )
      .then((resp) => {
        if (controller.signal.aborted) return;
        const hit = resp.events.find((e) => e.id === rawEvent) ?? null;
        setEvent(hit);
        setNotFound(hit === null);
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setEvent(null);
          setNotFound(true);
        }
      });
    return () => controller.abort();
  }, [active, rawSession, rawEvent]);

  const close = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("event");
        next.delete("event_session");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  if (!active) return null;
  if (!event && notFound) {
    // Surface the miss explicitly so the operator isn't left
    // staring at a blank screen. Long sessions ( > 2000 events)
    // and pruned-history sessions land here.
    return (
      <div
        role="dialog"
        aria-label="Event not found"
        className="fixed right-0 top-0 z-[60] flex h-full w-[520px] flex-col p-6"
        style={{
          background: "var(--surface)",
          borderLeft: "1px solid var(--border)",
          color: "var(--text)",
        }}
      >
        <div className="text-sm font-semibold">Event not found</div>
        <div className="mt-2 text-xs text-text-muted">
          This event isn&apos;t in the latest {EVENT_DRAWER_FETCH_LIMIT}{" "}
          events for its run. Open the run drawer to scroll back
          through older history.
        </div>
        <button
          type="button"
          className="mt-4 self-start rounded border border-border px-2 py-1 text-xs text-text-muted hover:text-text"
          onClick={close}
        >
          Close
        </button>
      </div>
    );
  }
  return <EventDetailDrawer event={event} onClose={close} />;
}

/**
 * Host component for the Cmd+K search modal + its click routing.
 * Lives inside BrowserRouter so ``useNavigate`` is available; the
 * modal itself renders here so App.tsx stays a single-level wrapper.
 *
 * Routing pivot (supersedes F2): agent and event hits open
 * overlay drawers via setSearchParams on the CURRENT route — the
 * operator stays where they were. Only session hits navigate, to
 * /events?run=<id>, because the run drawer lives on that page.
 */
function CommandPaletteHost() {
  const [searchOpen, setSearchOpen] = useState(false);
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();

  const handleSearchClick = useCallback(() => {
    setSearchOpen(true);
  }, []);

  const handleSelectResult = useCallback(
    (
      type: "agent" | "session" | "event",
      item: SearchResultAgent | SearchResultSession | SearchResultEvent,
    ) => {
      if (type === "agent") {
        // Clear sibling drawer params so opening the agent drawer
        // from a search hit doesn't stack on top of an existing
        // event-detail or run drawer (architect review §critical 1).
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete("event");
          next.delete("event_session");
          next.delete("run");
          next.set("agent_drawer", (item as SearchResultAgent).agent_id);
          return next;
        });
        return;
      }
      if (type === "event") {
        const ev = item as SearchResultEvent;
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete("agent_drawer");
          next.delete("run");
          next.set("event", ev.event_id);
          next.set("event_session", ev.session_id);
          return next;
        });
        return;
      }
      navigate(buildSearchResultHref("session", item as SearchResultSession));
    },
    [navigate, setSearchParams],
  );

  return (
    <>
      <Nav onSearchClick={handleSearchClick} />
      <div className="flex-1 overflow-hidden">
        <Routes>
          <Route path="/" element={<Fleet />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/events" element={<Investigate />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/directives" element={<Directives />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </div>
      <CommandPalette
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onSelectResult={handleSelectResult}
      />
      <AgentDrawerHost />
      <EventDetailDrawerHost />
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex h-screen flex-col">
        <CommandPaletteHost />
      </div>
    </BrowserRouter>
  );
}
