import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:8766",
    viewport: { width: 1512, height: 982 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { executablePath: process.env.DUCKPAD_CHROMIUM_EXECUTABLE },
  },
  webServer: {
    command: "../.venv/bin/python ../scripts/e2e_server.py",
    url: "http://127.0.0.1:8766",
    reuseExistingServer: false,
    timeout: 15000,
  },
});
