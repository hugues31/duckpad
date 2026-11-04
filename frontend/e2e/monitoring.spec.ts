import { expect, test } from "@playwright/test";
import en from "../src/locales/en.json" with { type: "json" };
import { openInstanceSettings, signIn } from "./helpers";

test("refresh interval controls both metrics and logs, including manual mode", async ({
  page,
}) => {
  await signIn(page);
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  let summaries = 0;
  let logs = 0;
  await page.route("**/api/monitoring", (route) =>
    route.fulfill({
      json: {
        sampled_at: new Date(++summaries * 1000).toISOString(),
        version: "0.0.0",
        uptime_seconds: 3600,
        disk: null,
        process_memory_bytes: null,
        resources: { memory_bytes: null, memory_total_bytes: null },
      },
    }),
  );
  await page.route("**/api/monitoring/logs?*", (route) =>
    route.fulfill({
      json: {
        entries: [
          {
            id: ++logs,
            timestamp: new Date().toISOString(),
            level: "info",
            logger: "duckpad.app",
            message: `Refresh ${logs}`,
            truncated: false,
          },
        ],
        retained: 1,
        matched: 1,
        capacity: 1000,
      },
    }),
  );
  await openInstanceSettings(page, en.monitoring);
  const panel = page.getByRole("region", { name: en.monitoring, exact: true });
  const interval = panel.getByRole("combobox", {
    name: en.monitoringRefreshInterval,
  });
  const expectRefreshes = async (count: number) => {
    await expect(panel.locator(".monitoring-updated")).toHaveAttribute(
      "datetime",
      new Date(count * 1000).toISOString(),
    );
    await expect(panel.locator(".monitoring-log-list pre")).toHaveText(
      `Refresh ${count}`,
    );
    expect([summaries, logs]).toEqual([count, count]);
  };
  await expect(interval).toHaveValue("5");
  await expectRefreshes(1);
  await page.clock.runFor(5000);
  await expectRefreshes(2);
  await interval.selectOption("10");
  await expectRefreshes(3);
  await page.clock.runFor(5000);
  await expectRefreshes(3);
  await page.clock.runFor(5000);
  await expectRefreshes(4);
  await interval.selectOption("0");
  await expectRefreshes(5);
  await page.clock.runFor(60000);
  await expectRefreshes(5);
  await panel
    .getByRole("button", { name: en.monitoringRefresh, exact: true })
    .click();
  await expectRefreshes(6);
});

test("administrators can inspect metrics and filter recent backend logs", async ({
  page,
}) => {
  await signIn(page);
  await openInstanceSettings(page, en.monitoring);
  await expect(page).toHaveURL(/\/instance-settings\/monitoring$/);
  const panel = page.getByRole("region", { name: en.monitoring, exact: true });
  const disk = panel.getByRole("region", {
    name: en.monitoringDisk,
    exact: true,
  });
  await expect(disk.getByRole("progressbar")).toBeVisible();
  await expect(
    panel.getByRole("region", { name: en.monitoringBackend, exact: true }),
  ).toContainText("Duckpad");
  await panel
    .getByRole("combobox", { name: en.monitoringRefreshInterval })
    .selectOption("0");
  await panel
    .getByRole("searchbox", { name: en.monitoringLogSearch })
    .fill("no-such-log-entry");
  await expect(
    panel.getByText(en.monitoringLogsEmpty, { exact: true }),
  ).toBeVisible();

  const entries = [
    {
      id: 2,
      timestamp: "2026-01-01T12:00:00Z",
      level: "error",
      logger: "duckpad.app",
      message: '<script>alert("not executable")</script>\nDiagnostic details',
      truncated: true,
    },
    {
      id: 1,
      timestamp: "2026-01-01T11:00:00Z",
      level: "info",
      logger: "uvicorn.error",
      message: "Application startup complete.",
      truncated: false,
    },
  ];
  await page.route("**/api/monitoring/logs?*", (route) => {
    const query = new URL(route.request().url()).searchParams;
    const filtered = entries.filter(
      (entry) =>
        (query.get("level") !== "error" || entry.level === "error") &&
        entry.message
          .toLowerCase()
          .includes((query.get("q") || "").toLowerCase()),
    );
    return route.fulfill({
      json: {
        entries: filtered,
        retained: 2,
        matched: filtered.length,
        capacity: 1000,
      },
    });
  });
  await panel.getByRole("searchbox", { name: en.monitoringLogSearch }).fill("");
  const list = panel.getByRole("list", {
    name: en.monitoringLogs,
    exact: true,
  });
  await expect(list.getByRole("listitem")).toHaveCount(2);
  await expect(list.getByRole("listitem").first()).toContainText(
    entries[0].message,
  );
  await expect(list.locator("script")).toHaveCount(0);
  await expect(list.getByText(en.monitoringLogTruncated)).toBeVisible();
  await panel
    .getByRole("combobox", { name: en.monitoringLogLevel, exact: true })
    .selectOption("error");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await panel
    .getByRole("combobox", { name: en.monitoringLogLevel, exact: true })
    .selectOption("debug");
  await panel
    .getByRole("searchbox", { name: en.monitoringLogSearch })
    .fill("STARTUP");
  await expect(list.getByRole("listitem")).toHaveCount(1);
  await expect(list).toContainText("Application startup complete.");
  await page.reload();
  await expect(disk.getByRole("progressbar")).toBeVisible();
});

test("monitoring reports unavailable metrics, low disk space and refresh errors", async ({
  page,
}) => {
  await signIn(page);
  let fail = false;
  let lowDisk = false;
  await page.route("**/api/monitoring", (route) => {
    if (fail)
      return route.fulfill({
        status: 503,
        json: { error: "Monitoring temporarily unavailable" },
      });
    return route.fulfill({
      json: {
        sampled_at: new Date().toISOString(),
        version: "0.0.0",
        uptime_seconds: 3600,
        disk: lowDisk
          ? { total_bytes: 1000, free_bytes: 50, used_bytes: 950 }
          : null,
        process_memory_bytes: null,
        resources: { memory_bytes: null, memory_total_bytes: null },
      },
    });
  });
  await openInstanceSettings(page, en.monitoring);
  const panel = page.getByRole("region", { name: en.monitoring, exact: true });
  const disk = panel.getByRole("region", {
    name: en.monitoringDisk,
    exact: true,
  });
  await expect(disk).toContainText(en.monitoringUnavailable);
  await expect(disk.getByRole("progressbar")).toHaveCount(0);
  await panel
    .getByRole("combobox", { name: en.monitoringRefreshInterval })
    .selectOption("0");
  fail = true;
  await panel.getByRole("button", { name: en.monitoringRefresh }).click();
  await expect(panel.getByRole("alert")).toHaveText(
    "Monitoring temporarily unavailable",
  );
  fail = false;
  lowDisk = true;
  await panel.getByRole("button", { name: en.monitoringRefresh }).click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(disk.getByRole("status")).toHaveText(en.monitoringDiskLow);

  await page.route("**/api/monitoring/logs?*", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Logs temporarily unavailable" },
    }),
  );
  await panel.getByRole("button", { name: en.monitoringRefresh }).click();
  await expect(panel.getByRole("alert")).toHaveText(
    "Logs temporarily unavailable",
  );
  await expect(disk.getByRole("progressbar")).toBeVisible();
  await page.unroute("**/api/monitoring/logs?*");
  await panel.getByRole("button", { name: en.monitoringRefresh }).click();
  await expect(panel.getByRole("alert")).toHaveCount(0);
});
