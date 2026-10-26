import { test, expect, type Page } from "@playwright/test";
import fr from "../src/locales/fr.json" with { type: "json" };

async function signIn(page: Page) {
  await page.goto("/");
  await page
    .getByLabel("Password", { exact: true })
    .fill("duckpad-browser-test");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Workspace", exact: true }),
  ).toBeVisible();
}

test("live server metrics, popup dismissal, mobile layout and translated dark theme", async ({
  page,
}) => {
  await signIn(page);
  const widget = page.getByRole("button", {
    name: "Resource usage",
    exact: true,
  });
  await expect(widget).toContainText(/CPU\s+\d+\.\d+ %/);
  await expect(widget).toContainText(/RAM\s+\d+\.\d+ MiB/);
  await widget.focus();
  await page.keyboard.press("Enter");
  const popup = page.getByRole("dialog", { name: "Resource usage" });
  await expect(popup).toBeVisible();
  await expect(popup.getByRole("img")).toHaveCount(2);
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
            memory_bytes: memory,
          },
    });
  });
  await signIn(page);
  const widget = page.getByRole("button", {
    name: "Resource usage",
    exact: true,
  });
  await expect(widget).toContainText("CPU 150.0 %");
  await widget.click();
  const popup = page.getByRole("dialog", { name: "Resource usage" });
  await expect(popup.locator(".resource-cpu text")).toHaveText("150.0 %");
  memory = 128 * 1024 ** 2;
  await expect(widget).toContainText("RAM 128.0 MiB");
  await expect(
    popup.locator(".resource-memory .resource-line"),
  ).toHaveAttribute("d", /L/);
  failed = true;
  await expect(popup.getByRole("status")).toHaveText(
    "Metrics unavailable. Retrying…",
  );
  await expect(widget).toContainText("CPU —");
  await expect(widget).toContainText("RAM —");
  failed = false;
  await expect(widget).toContainText("RAM 128.0 MiB");
  await expect(widget).toContainText("CPU 150.0 %");
  await expect(popup.getByRole("status")).toHaveCount(0);
  await expect(popup.locator(".resource-cpu .resource-line")).toHaveAttribute(
    "d",
    /M.*M/,
  );

  processId = 2;
  memory = null;
  await expect(widget).toContainText("CPU —");
  await expect(widget).toContainText("RAM —");
  await expect(popup.getByRole("status")).toContainText(
    "RAM measurement is unavailable",
  );
  await expect(widget).toContainText("CPU 150.0 %");

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
