import { useState, useCallback } from "react";
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
import { Policies } from "@/pages/Policies";
import { Directives } from "@/pages/Directives";
import { NotFound } from "@/pages/NotFound";
import { Analytics } from "@/pages/Analytics";
import { Investigate } from "@/pages/Investigate";
import { Settings } from "@/pages/Settings";
import { CommandPalette } from "@/components/search/CommandPalette";
import type {
  SearchResultAgent,
  SearchResultEvent,
  SearchResultSession,
} from "@/lib/types";
import { useTheme } from "@/hooks/useTheme";

function Nav({ onSearchClick }: { onSearchClick: () => void }) {
  const { theme, toggleTheme } = useTheme();

  return (
    <nav
      className="flex h-[44px] items-center border-b px-4"
      style={{
        background: "var(--surface)",
        borderColor: "var(--border)",
      }}
    >
      <span className="text-[15px] font-semibold" style={{ color: "var(--text)" }}>
        Flightdeck
      </span>

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
 * Routing helper for the global search modal. An agent click routes
 * to the Events page scoped to that agent (``?agent_id=``); a
 * session or event click routes to ``/events?run=<session_id>``,
 * which the Events page picks up to open the run drawer. The
 * legacy ``?session=`` param is still redirected to ``?run=`` by
 * the Events page, so older links keep resolving.
 */
export function buildSearchResultHref(
  type: "agent" | "session" | "event",
  item: SearchResultAgent | SearchResultSession | SearchResultEvent,
): string {
  if (type === "agent") {
    // F2: route to agent_id, not flavor=agent_name. The previous
    // ``flavor=`` form silently produced an empty session list for
    // sensor-keyed agents whose agent_name is ``user@hostname`` and
    // never matches any session.flavor. agent_id is now carried on
    // SearchResultAgent (D115) and the Investigate parseUrlState
    // already handles ``?agent_id=<uuid>``.
    return `/events?agent_id=${encodeURIComponent(
      (item as SearchResultAgent).agent_id,
    )}`;
  }
  if (type === "session") {
    return `/events?run=${encodeURIComponent(
      (item as SearchResultSession).session_id,
    )}`;
  }
  // event -- route to the parent run's drawer.
  return `/events?run=${encodeURIComponent(
    (item as SearchResultEvent).session_id,
  )}`;
}

// Strict RFC-4122 gate for the ``?agent_drawer=`` param. Every
// agent_id is a uuid5 (the sensor's derive_agent_id), so the
// canonical 8-4-4-4-12 shape rejects nothing legitimate while a
// malformed bookmark or crafted URL silently no-ops (the drawer
// stays closed) instead of opening on garbage.
const AGENT_DRAWER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Host component for the Cmd+K search modal + its click routing.
 * Lives inside BrowserRouter so ``useNavigate`` is available; the
 * modal itself renders here so App.tsx stays a single-level wrapper.
 */
function CommandPaletteHost() {
  const [searchOpen, setSearchOpen] = useState(false);
  const navigate = useNavigate();

  const handleSearchClick = useCallback(() => {
    setSearchOpen(true);
  }, []);

  const handleSelectResult = useCallback(
    (
      type: "agent" | "session" | "event",
      item: SearchResultAgent | SearchResultSession | SearchResultEvent,
    ) => {
      navigate(buildSearchResultHref(type, item));
    },
    [navigate],
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
