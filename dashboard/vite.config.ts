import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-router",
      "recharts",
      "d3-scale",
      "d3-time",
      "lucide-react",
      "@radix-ui/react-select",
      "@radix-ui/react-dialog",
      "@radix-ui/react-tooltip",
      "zustand",
      "motion/react",
      "clsx",
      "tailwind-merge",
    ],
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 3000,
    host: true,
    watch: {
      usePolling: true,
      interval: 1000,
    },
    warmup: {
      clientFiles: [
        "./src/pages/Fleet.tsx",
        "./src/pages/Analytics.tsx",
        "./src/components/timeline/Timeline.tsx",
        "./src/components/fleet/LiveFeed.tsx",
      ],
    },
    // The paths are forwarded as sent: the services serve their routes
    // under /api and /ingest themselves. The target is the flightdeck
    // binary on :4000 (the dev stack, `make dev`); FLIGHTDECK_DEV_TARGET
    // points the proxy elsewhere.
    proxy: {
      "/api": { target: process.env.FLIGHTDECK_DEV_TARGET ?? "http://localhost:4000" },
      "/ingest": { target: process.env.FLIGHTDECK_DEV_TARGET ?? "http://localhost:4000" },
    },
  },
});
