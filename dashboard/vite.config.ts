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
  server: {
    port: 3000,
    host: true,
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
