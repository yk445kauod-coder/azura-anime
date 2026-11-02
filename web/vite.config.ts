import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const WORKER = process.env.IGNIS_LIVE_URL || "https://ignis-agent.yk445kauod.workers.dev";

// Dev-only proxy mirrors the production Pages Function: /api/<path> -> worker /<path>.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    proxy: {
      "/api": {
        target: WORKER,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
