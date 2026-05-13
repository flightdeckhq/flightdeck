import { useState, useCallback } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  useNavigate,
} from "react-router-dom";
import { Search, Settings as SettingsIcon, Sun, Moon } from "lucide-react";
import { Fleet } from "@/pages/Fleet";
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
 * Routing helper for the global search modal. Agent clicks navigate
 * to the Events page with the flavor pre-filtered; session and event
 * clicks navigate to /events with the ``session`` URL param set,
 * which the Investigate component's drawer picks up via useEffect.
 * Event clicks target the parent session drawer (per-event deep-
 * linking with ``directEventDetail`` is a separate follow-up).
 *
 * The URL param name for flavor is the singular ``flavor=`` -- the
 * Investigate parseUrlState reads via ``sp.getAll("flavor")``. The
 * ``session=`` query param name is the wire identifier the Events
 * page's URL parser still keys on; the rendered prose calls it a
 * "run" while the param keeps its historical name.
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
    return `/events?session=${encodeURIComponent(
      (item as SearchResultSession).session_id,
    )}`;
  }
  // event -- route to the parent session's drawer.
  return `/events?session=${encodeURIComponent(
    (item as SearchResultEvent).session_id,
  )}`;
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
