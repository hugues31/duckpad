/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: { outDir: "../src/duckpad/static", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:8765" } },
  test: {
    // Unit tests sit next to their sources; e2e/ holds the Playwright specs.
    // They run in Node; hook tests opt into a DOM with a
    // `// @vitest-environment happy-dom` comment.
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
