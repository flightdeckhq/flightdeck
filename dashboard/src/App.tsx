import { useState, useCallback } from "react";
import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { Search } from "lucide-react";
import { Fleet } from "@/pages/Fleet";
import { Policies } from "@/pages/Policies";
import { Analytics } from "@/pages/Analytics";
import { CommandPalette } from "@/components/search/CommandPalette";

function Nav({ onSearchClick }: { onSearchClick: () => void }) {
  return (
    <nav className="flex h-10 items-center gap-4 border-b border-border bg-surface px-4">
      <span className="text-sm font-semibold text-primary">Flightdeck</span>
      <NavLink
        to="/"
        end
        className={({ isActive }) =>
          `text-xs ${isActive ? "text-text" : "text-text-muted hover:text-text"}`
        }
      >
        Fleet
      </NavLink>
      <NavLink
        to="/policies"
        className={({ isActive }) =>
          `text-xs ${isActive ? "text-text" : "text-text-muted hover:text-text"}`
        }
      >
        Policies
      </NavLink>
      <NavLink
        to="/analytics"
        className={({ isActive }) =>
          `text-xs ${isActive ? "text-text" : "text-text-muted hover:text-text"}`
        }
      >
        Analytics
      </NavLink>
      <button
        onClick={onSearchClick}
        className="ml-auto flex items-center gap-1.5 rounded border border-border px-2 py-1 text-xs text-text-muted transition-colors hover:border-primary hover:text-text"
        aria-label="Search"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">Search</span>
        <kbd className="hidden rounded bg-surface-hover px-1 py-0.5 text-[10px] font-medium sm:inline">
          {navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}K
        </kbd>
      </button>
    </nav>
  );
}

export default function App() {
  const [searchOpen, setSearchOpen] = useState(false);

  const handleSearchClick = useCallback(() => {
    setSearchOpen(true);
  }, []);

  return (
    <BrowserRouter>
      <div className="flex h-screen flex-col">
        <Nav onSearchClick={handleSearchClick} />
        <div className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<Fleet />} />
            <Route path="/policies" element={<Policies />} />
            <Route path="/analytics" element={<Analytics />} />
          </Routes>
        </div>
        <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
      </div>
    </BrowserRouter>
  );
}
