import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { Fleet } from "@/pages/Fleet";
import { Policies } from "@/pages/Policies";
import { Analytics } from "@/pages/Analytics";

function Nav() {
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
    </nav>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex h-screen flex-col">
        <Nav />
        <div className="flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<Fleet />} />
            <Route path="/policies" element={<Policies />} />
            <Route path="/analytics" element={<Analytics />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
}
