import { defineConfig } from "@playwright/test";
import appConfig from "./playwright.config";

const port = process.env.DUCKPAD_SITE_PORT || "4322";
const prefix = (process.env.WEBSITE_BASE_PATH || "/").replace(/\/$/, "");
const baseURL = `http://127.0.0.1:${port}${prefix}/`;

export default defineConfig({
  testDir: "./docs",
  testMatch: "site.spec.ts",
  workers: 1,
  timeout: 30000,
  reporter: "list",
  use: { ...appConfig.use, baseURL, locale: "en-US", colorScheme: "light" },
  webServer: {
    command: `npm run preview --prefix ../website -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
  },
});
