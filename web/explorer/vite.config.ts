import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev: the browser sees one origin — Vite proxies /api/* to the Hono server
// (scripts/serve.ts, default port 8788). Later: the Vite build deploys to
// Cloudflare Pages with the API as a Worker on the same zone, so no CORS ever.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Single-source submission validation: the SPA runs the same runtime-free
      // parseStoreInput the server enforces (mirrored in tsconfig.json paths).
      "@jobs/validate": fileURLToPath(new URL("../../src/jobs/validate.ts", import.meta.url)),
      // Shared, runtime-free modules: the pi injection caveat (must be verbatim
      // everywhere) and the model table lookup (one matcher, not a copy).
      "@pi/caveat": fileURLToPath(new URL("../../src/methodologies/pi/caveat.ts", import.meta.url)),
      "@llm/model-table": fileURLToPath(new URL("../../src/llm/model-table.ts", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:8788", changeOrigin: false },
    },
  },
});
