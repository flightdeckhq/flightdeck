import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    // Playwright specs live under tests/e2e/ and are only discovered
    // by the Playwright runner (playwright.config.ts). Vitest would
    // otherwise try to load @playwright/test into jsdom and fail on
    // the first import.
    exclude: ["**/node_modules/**", "**/tests/e2e/**"],
  },
});
