import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    include: [
      "react",
      "react-dom",
      "react-router-dom",
      "recharts",
      "d3-scale",
      "d3-time",
      "lucide-react",
      "@radix-ui/react-select",
      "@radix-ui/react-dialog",
      "@radix-ui/react-tooltip",
      "zustand",
      "framer-motion",
      "clsx",
      "tailwind-merge",
    ],
  },
  esbuild: {
    target: "chrome90",
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 3000,
    host: true,
    warmup: {
      clientFiles: [
        "./src/pages/Fleet.tsx",
        "./src/pages/Analytics.tsx",
        "./src/components/timeline/Timeline.tsx",
        "./src/components/fleet/LiveFeed.tsx",
      ],
    },
    proxy: {
      "/api": {
        target: "http://localhost:8081",
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
      "/ingest": {
        target: "http://localhost:8080",
        rewrite: (p) => p.replace(/^\/ingest/, ""),
      },
    },
  },
});
