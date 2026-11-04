import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const WORKER = process.env.IGNIS_LIVE_URL || "https://ignis-agent.yk445kauod.workers.dev";

// Dev-only proxy mirrors the production Pages Function: /api/<path> -> worker /<path>.
export default defineConfig({
  plugins: [react(), tailwindcss()],
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
  // `vite preview` serves the built bundle and needs the same proxy as dev,
  // otherwise /api calls would 404 when checking a production build locally.
  preview: {
    port: 12000,
    host: "0.0.0.0",
    // The sandbox exposes the dev server through a proxy host, so it must be
    // allowed explicitly or Vite rejects the request.
    allowedHosts: true,
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
    // Warn only when a chunk is genuinely huge; the 3D chunk is expected to be
    // large and is loaded on demand, so it must not drown the signal.
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Keep the WebGL stack in its own chunk so it is only ever fetched by
          // devices that actually open the ISS panel.
          if (id.includes("node_modules/three") || id.includes("@react-three")) return "three";
          if (id.includes("node_modules/react")) return "react";
          return undefined;
        },
      },
    },
  },
});
