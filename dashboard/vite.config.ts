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
    // The paths are forwarded as sent, as the compose nginx does: the
    // services serve their routes under /api and /ingest themselves.
    proxy: {
      "/api": { target: "http://localhost:8081" },
      "/ingest": { target: "http://localhost:8080" },
    },
  },
});
