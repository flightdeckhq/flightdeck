import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";
import { ensureAccessToken } from "./lib/runtime-config";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("missing #root element in index.html");
}

// Resolve the access token before mounting React so every downstream
// caller of getAccessTokenSync() finds a populated in-memory token.
// This fetches /runtime-config.json (cache: no-store) on every page
// load — the token is memory-only and never persisted, so there is no
// cached value to short-circuit to. Bootstrap failures render an
// inline message instead of an empty page so the operator sees the
// fix path verbatim.
ensureAccessToken()
  .then(() => {
    ReactDOM.createRoot(rootEl).render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    );
  })
  .catch((err) => {
    rootEl.textContent = err instanceof Error ? err.message : String(err);
    rootEl.setAttribute("data-bootstrap-error", "true");
  });
