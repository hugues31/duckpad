import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

const testPort = process.env.DUCKPAD_E2E_PORT || "8766";
const testURL = `http://127.0.0.1:${testPort}`;

const browserLibraries =
  process.env.DUCKPAD_BROWSER_LIBRARY_PATH ??
  `${homedir()}/.local/share/duckpad-tools/browser-libs/usr/lib/x86_64-linux-gnu`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: testURL,
    viewport: { width: 1512, height: 982 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: {
      executablePath: process.env.DUCKPAD_CHROMIUM_EXECUTABLE,
      ...(existsSync(browserLibraries)
        ? {
            env: {
              ...process.env,
              LD_LIBRARY_PATH: [browserLibraries, process.env.LD_LIBRARY_PATH]
                .filter(Boolean)
                .join(":"),
            },
          }
        : {}),
    },
  },
  webServer: {
    command: "../.venv/bin/python ../scripts/e2e_server.py",
    url: testURL,
    reuseExistingServer: false,
    timeout: 15000,
  },
});
