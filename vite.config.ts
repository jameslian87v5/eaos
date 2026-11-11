import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  root: "client",
  server: {
    proxy: {
      "/api": "http://localhost:3001",
      "/ws": {
        target: "ws://localhost:3001",
        ws: true,
      },
    },
  },
  build: {
    outDir: "../dist",
    rollupOptions: {
      // Multi-page: main SPA + embeddable widget iframe. Absolute paths
      // (resolved relative to this config) so they don't depend on CWD; both
      // entries emit to ../dist.
      input: {
        index: fileURLToPath(new URL("./client/index.html", import.meta.url)),
        widget: fileURLToPath(new URL("./client/widget.html", import.meta.url)),
      },
    },
  },
});
