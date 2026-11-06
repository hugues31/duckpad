import { test, expect } from "@playwright/test";
import { signIn } from "./helpers";

// Hold stages at the HTTP boundary so fast local caches cannot hide transitions.
test("Python preparation is visible in the workspace and retained in settings", async ({
  page,
}) => {
  await signIn(page);
  const created = await page.request.post("/api/projects", {
    data: { name: "Python progress" },
  });
  expect(created.ok()).toBeTruthy();
  const tree = await created.json();
  expect(
    (
      await page.request.put(`/api/projects/${tree.project}/python`, {
        data: { enabled: true, allow_builds: false },
      })
    ).ok(),
  ).toBeTruthy();
  let status = {
    state: "unprepared",
    stage: "waiting",
    operation: "",
    started_at: 0,
    elapsed_seconds: 0,
    python: "3.12.12",
    duckdb: "2.0.0",
    log: "",
    error: "",
  };
  await page.route(`**/projects/${tree.project}/python/environment`, (route) =>
    route.fulfill({ json: status }),
  );
  await page.goto(`/worktrees/${tree.id}/flow`);
  const panel = page.getByRole("region", { name: "Python environments" });
  await expect(panel).toHaveCount(0);
  status = {
    ...status,
    state: "resolving",
    stage: "resolving",
    operation: "resolution",
    started_at: Date.now() / 1000,
    elapsed_seconds: 2,
    log: "Resolving 3 dependencies",
  };
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("status")).toContainText(
    "Resolving dependencies",
  );
  await expect(panel.getByRole("progressbar")).toBeVisible();
  await expect(panel.getByRole("progressbar")).not.toHaveAttribute("value");
  await panel.getByText("Preparation log", { exact: true }).click();
  await expect(panel.getByRole("log")).toContainText(
    "Resolving 3 dependencies",
  );
  status = {
    ...status,
    state: "installing",
    stage: "installing",
    operation: "installation",
    log: "Downloading package\nInstalling dependencies",
    elapsed_seconds: 5,
  };
  await expect(panel.getByRole("log")).toContainText("Installing dependencies");
  await expect(panel).toContainText("Elapsed: 5s");
  // Joining an existing preparation must still show its eventual result.
  await page.reload();
  await expect(panel.getByRole("progressbar")).toBeVisible();
  status = { ...status, state: "ready", log: "Installed 3 packages" };
  await expect(panel.getByRole("status")).toContainText("Environment ready");
  await expect(panel.getByRole("progressbar")).toHaveCount(0);
  await panel.getByRole("button", { name: "Close", exact: true }).click();
  await expect(panel).toHaveCount(0);

  status = {
    ...status,
    state: "error",
    operation: "failed-installation",
    started_at: Date.now() / 1000,
    log: "No matching distribution",
    error: "Python environment preparation failed: No matching distribution",
  };
  await expect(panel.getByRole("status")).toHaveText("Preparation failed");
  await expect(panel.locator(".error")).toContainText(
    "No matching distribution",
  );
  await panel.getByText("Preparation log", { exact: true }).click();
  await expect(panel.getByRole("log")).toContainText(
    "No matching distribution",
  );
  await page.goto(`/projects/${tree.project}/settings/python`);
  await expect(panel.locator(".error")).toContainText(
    "No matching distribution",
  );
  await panel.getByText("Preparation log", { exact: true }).click();
  await expect(panel.getByRole("log")).toContainText(
    "No matching distribution",
  );

  await page.goto(`/worktrees/${tree.id}/flow`);
  // Historical errors stay in settings, not as a new workspace notification.
  await expect(panel).toHaveCount(0);
});
