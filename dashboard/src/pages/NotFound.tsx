// Catch-all 404 (D146). Wired in App.tsx as ``<Route path="*">``.
// Renders inside the existing nav chrome so the operator can
// navigate elsewhere without a full reload. Reached via paths
// like ``/mcp-policies`` (retired in step 6.8 cleanup) or any
// other unmatched URL.

import { Link } from "react-router-dom";

export function NotFound() {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 p-12 text-center"
      data-testid="not-found"
    >
      <h1
        className="text-xl font-semibold"
        style={{ color: "var(--text)" }}
      >
        Page not found
      </h1>
      <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
        The path you tried to reach doesn&apos;t exist.
      </p>
      <Link
        to="/"
        className="text-sm underline"
        style={{ color: "var(--accent)" }}
        data-testid="not-found-home-link"
      >
        Back to Fleet
      </Link>
    </div>
  );
}
