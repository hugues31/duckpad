import { defineConfig } from "@playwright/test";
import appConfig from "./playwright.config";

export default defineConfig({
  ...appConfig,
  testDir: "./docs",
  testMatch: ["capture.spec.ts", "screenshots.spec.ts"],
  timeout: 90000,
  reporter: "list",
  use: {
    ...appConfig.use,
    locale: "en-US",
    colorScheme: "light",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 1000 },
  },
});
