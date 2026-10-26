import { test, expect, type Page } from "@playwright/test";
import fr from "../src/locales/fr.json" with { type: "json" };
import { signIn } from "./helpers";

test("live server metrics, popup dismissal, mobile layout and translated dark theme", async ({
  page,
}) => {
  await signIn(page);
  const widget = page.getByRole("button", {
    name: "Resource usage",
    exact: true,
  });
  await expect(widget.locator(".resource-cpu b")).toHaveText(/\d+\.\d+ %/);
  await expect(widget.locator(".resource-memory b")).toHaveText(/\d+\.\d+ %/);
  await expect(widget).not.toContainText(/MiB|GiB/);
  await expect(widget.locator(".resource-meter-fill")).toHaveCount(2);
  await expect(page.locator(".resource-memory-detail")).toBeHidden();
  await widget.focus();
  await page.keyboard.press("Enter");
  const popup = page.getByRole("dialog", { name: "Resource usage" });
  await expect(popup).toBeVisible();
  await expect(popup.getByRole("img")).toHaveCount(2);
  await expect(popup.locator(".resource-memory-detail")).toContainText(
    "RAM used / total",
  );
  await expect(popup.locator(".resource-memory-detail strong")).toHaveText(
    /\d+\.\d+ (MiB|GiB) \/ \d+\.\d+ (MiB|GiB)/,
  );
  await expect(popup.locator(".resource-cpu .resource-line")).toHaveAttribute(
    "d",
    /L/,
  );
  await page.keyboard.press("Escape");
  await expect(popup).toBeHidden();
  await expect(widget).toBeFocused();
  await widget.click();
  await page
    .getByRole("navigation", { name: "Workspace", exact: true })
    .click();
  await expect(popup).toBeHidden();

  await page.getByTitle("Account menu", { exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Dark", exact: true }).click();
  await page.getByTitle("Account menu", { exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "French", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: fr.resourceMonitor, exact: true })
    .click();
  const translated = page.getByRole("dialog", { name: fr.resourceMonitor });
  await expect(translated).toContainText(fr.resourceScope);
  await expect(translated).toContainText(fr.resourceMemoryAmount);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const bounds = await translated.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await translated.getByTitle(fr.close, { exact: true }).click();
  await expect(translated).toBeHidden();
});

test("metrics retain a bounded history and recover honestly from outages and server restarts", async ({
  page,
}) => {
  let calls = 0;
  let failed = false;
  let processId = 1;
  let memory: number | null = 256 * 1024 ** 2;
  await page.route("**/api/resources", async (route) => {
    calls++;
    await route.fulfill({
      status: failed ? 503 : 200,
      json: failed
        ? { error: "Unavailable" }
        : {
            process_id: processId,
            sampled_at: calls * 2,
            cpu_seconds: calls * 3,
            cpu_capacity: 4,
            memory_bytes: memory,
            memory_total_bytes: 1024 ** 3,
          },
    });
  });
  await signIn(page);
  const widget = page.getByRole("button", {
    name: "Resource usage",
    exact: true,
  });
  const cpuValue = widget.locator(".resource-cpu b");
  const ramValue = widget.locator(".resource-memory b");
  await expect(cpuValue).toHaveText("37.5 %");
  await expect(ramValue).toHaveText("25.0 %");
  await expect(
    widget.locator(".resource-cpu .resource-meter-fill"),
  ).toHaveAttribute("style", "width: 37.5%;");
  await expect(
    widget.locator(".resource-memory .resource-meter-fill"),
  ).toHaveAttribute("style", "width: 25%;");
  await widget.click();
  const popup = page.getByRole("dialog", { name: "Resource usage" });
  await expect(popup.locator(".resource-cpu text")).toHaveText("100 %");
  await expect(popup.locator(".resource-memory-detail strong")).toHaveText(
    "256.0 MiB / 1.0 GiB",
  );
  memory = 128 * 1024 ** 2;
  await expect(ramValue).toHaveText("12.5 %");
  await expect(popup.locator(".resource-memory-detail strong")).toHaveText(
    "128.0 MiB / 1.0 GiB",
  );
  await expect(
    popup.locator(".resource-memory .resource-line"),
  ).toHaveAttribute("d", /L/);
  failed = true;
  await expect(popup.getByRole("status")).toHaveText(
    "Metrics unavailable. Retrying…",
  );
  await expect(cpuValue).toHaveText("—");
  await expect(ramValue).toHaveText("—");
  await expect(
    widget.locator(".resource-memory .resource-meter-fill"),
  ).toHaveAttribute("style", "width: 0%;");
  failed = false;
  await expect(ramValue).toHaveText("12.5 %");
  await expect(cpuValue).toHaveText("37.5 %");
  await expect(popup.getByRole("status")).toHaveCount(0);
  await expect(popup.locator(".resource-cpu .resource-line")).toHaveAttribute(
    "d",
    /M.*M/,
  );

  processId = 2;
  memory = null;
  await expect(cpuValue).toHaveText("—");
  await expect(ramValue).toHaveText("—");
  await expect(popup.getByRole("status")).toContainText(
    "RAM measurement is unavailable",
  );
  await expect(cpuValue).toHaveText("37.5 %");

  await page.clock.install();
  const before = calls;
  await page.clock.fastForward(122_000);
  await expect.poll(() => calls).toBeGreaterThan(before);
  await expect(
    popup.locator(".resource-cpu .resource-line"),
  ).not.toHaveAttribute("d", /L/);
  await page.keyboard.press("Escape");
  await page.getByTitle("Account menu", { exact: true }).click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(widget).toHaveCount(0);
  const afterLogout = calls;
  await page.clock.fastForward(10_000);
  expect(calls).toBe(afterLogout);
});

test("unknown capacities stay unavailable and capacity changes reset CPU sampling", async ({
  page,
}) => {
  let calls = 0;
  let cpuCapacity = 0;
  let totalMemory: number | null = null;
  await page.route("**/api/resources", async (route) => {
    calls++;
    await route.fulfill({
      json: {
        process_id: 1,
        sampled_at: calls * 2,
        cpu_seconds: calls * 3,
        cpu_capacity: cpuCapacity,
        memory_bytes: 256 * 1024 ** 2,
        memory_total_bytes: totalMemory,
      },
    });
  });
  await signIn(page);
  const widget = page.getByRole("button", {
    name: "Resource usage",
    exact: true,
  });
  await widget.click();
  await expect(page.locator(".resource-memory-detail strong")).toHaveText(
    "256.0 MiB / —",
  );
  await expect(widget.locator(".resource-cpu b")).toHaveText("—");
  await expect(widget.locator(".resource-memory b")).toHaveText("—");
  cpuCapacity = 4;
  totalMemory = 512 * 1024 ** 2;
  await expect(widget.locator(".resource-cpu b")).toHaveText("37.5 %");
  await expect(widget.locator(".resource-memory b")).toHaveText("50.0 %");
  cpuCapacity = 1;
  await expect(widget.locator(".resource-cpu b")).toHaveText("—");
  await expect(widget.locator(".resource-cpu b")).toHaveText("100.0 %");
  await expect(
    widget.locator(".resource-cpu .resource-meter-fill"),
  ).toHaveAttribute("style", "width: 100%;");
  totalMemory = 0;
  await expect(widget.locator(".resource-memory b")).toHaveText("—");
  await expect(widget).not.toContainText(/NaN|Infinity/);
});
