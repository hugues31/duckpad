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
  let status: Record<string, unknown> = {
    state: "error",
    stage: "resolving",
    operation: "before-opening",
    elapsed_seconds: 1,
    python: "3.12.12",
    duckdb: "2.0.0",
    log: "Old failure",
    error: "Old failure",
  };
  await page.route(
    `**/projects/${tree.project}/python/environment?worktree=${tree.id}`,
    (route) => route.fulfill({ json: status }),
  );
  await page.goto(`/worktrees/${tree.id}/flow`);
  await expect(
    page.getByRole("button", { name: "Run all", exact: true }),
  ).toBeVisible();
  const notice = page.getByRole("region", {
    name: "Python environment",
    exact: true,
  });
  // Results from before the page opened stay in settings.
  await expect(notice).toHaveCount(0);

  status = {
    ...status,
    state: "resolving",
    operation: "resolution",
    elapsed_seconds: 2,
    log: "Resolving 3 dependencies",
    error: null,
  };
  await expect(notice.getByRole("status")).toContainText(
    "Resolving dependencies",
  );
  await expect(notice.getByRole("progressbar")).not.toHaveAttribute("value");
  await expect(notice.getByRole("button", { name: "Close" })).toHaveCount(0);
  await notice.getByText("Preparation log", { exact: true }).click();
  await expect(notice.getByRole("log")).toContainText(
    "Resolving 3 dependencies",
  );
  status = {
    ...status,
    state: "installing",
    stage: "installing",
    log: "Downloading package\nInstalling dependencies",
    elapsed_seconds: 5,
  };
  await expect(notice.getByRole("log")).toContainText(
    "Installing dependencies",
  );
  await expect(notice).toContainText("5.0 s");
  // Joining a running preparation still shows its outcome.
  await page.reload();
  await expect(notice.getByRole("progressbar")).toBeVisible();
  status = { ...status, state: "ready", log: "Installed 3 packages" };
  await expect(notice.getByRole("status")).toContainText("Environment ready");
  await expect(notice.getByRole("progressbar")).toHaveCount(0);
  // A success closes by itself.
  await expect(notice).toHaveCount(0, { timeout: 15000 });

  // Reusing a cached environment installs nothing, so the workspace stays quiet.
  status = { ...status, operation: "cache-hit", stage: "cached", log: "" };
  await page.waitForTimeout(2500);
  await expect(notice).toHaveCount(0);

  status = {
    ...status,
    state: "error",
    stage: "resolving",
    operation: "failed-resolution",
    log: "No matching distribution",
    error: "Python environment preparation failed: No matching distribution",
  };
  await expect(notice.getByRole("status")).toContainText("Preparation failed");
  await expect(notice.locator(".notice.error")).toContainText(
    "No matching distribution",
  );
  await notice.getByRole("button", { name: "Close", exact: true }).click();
  await expect(notice).toHaveCount(0);

  await page.goto(`/projects/${tree.project}/settings/python`);
  const settings = page.getByRole("region", {
    name: "Python environments",
    exact: true,
  });
  await expect(settings.locator(".notice.error")).toContainText(
    "No matching distribution",
  );
  await settings.getByText("Preparation log", { exact: true }).click();
  await expect(settings.getByRole("log")).toContainText(
    "No matching distribution",
  );

  const branched = await page.request.post(
    `/api/worktrees/${tree.id}/branches`,
    {
      data: { name: "other-dependencies" },
    },
  );
  expect(branched.ok()).toBeTruthy();
  const branch = await branched.json();
  await page.route(
    `**/projects/${tree.project}/python/environment?worktree=${branch.id}`,
    (route) =>
      route.fulfill({
        json: {
          ...status,
          state: "ready",
          error: null,
          log: "Installed branch dependencies",
        },
      }),
  );
  await page.goto(
    `/projects/${tree.project}/settings/python?worktree=${branch.id}`,
  );
  await expect(settings.getByRole("status")).toContainText("Environment ready");
  await expect(settings.locator(".notice.error")).toHaveCount(0);
  await settings.getByText("Preparation log", { exact: true }).click();
  await expect(settings.getByRole("log")).toContainText(
    "Installed branch dependencies",
  );
  await page.goto(
    `/projects/${tree.project}/settings/python?worktree=${tree.id}`,
  );
  await expect(settings.locator(".notice.error")).toContainText(
    "No matching distribution",
  );
});

test("run details refresh preparation and the final status together", async ({
  page,
}) => {
  await signIn(page);
  const created = await page.request.post("/api/projects", {
    data: { name: "Run preparation" },
  });
  const tree = await created.json();
  let run = {
    id: "preparation-run",
    project: tree.project,
    worktree: tree.id,
    branch: tree.branch,
    environment: "dev",
    status: "preparing",
    commit: "",
    started: new Date().toISOString(),
    nodes: {},
    variables: {},
    connections: {},
    preparation: [
      {
        operation: "install",
        state: "installing",
        stage: "installing",
        log: "Downloading packages",
      },
    ],
  };
  await page.route("**/runs/preparation-run", (route) =>
    route.fulfill({ json: run }),
  );
  await page.goto(`/worktrees/${tree.id}/history?run=preparation-run`);
  const dialog = page.getByRole("dialog", { name: "View execution" });
  await expect(dialog.locator(".badge.preparing")).toBeVisible();
  const preparation = dialog.getByRole("region", {
    name: "Python environment",
    exact: true,
  });
  await expect(preparation.getByRole("progressbar")).toBeVisible();
  await preparation.getByText("Preparation log", { exact: true }).click();
  await expect(preparation.getByRole("log")).toContainText(
    "Downloading packages",
  );
  run = {
    ...run,
    status: "success",
    preparation: [
      { ...run.preparation[0], state: "ready", log: "Installed packages" },
    ],
  };
  await expect(dialog.locator(".badge.success")).toBeVisible();
  await expect(dialog.locator(".badge.preparing")).toHaveCount(0);
  await expect(preparation.getByRole("progressbar")).toHaveCount(0);
  await expect(preparation.getByRole("log")).toContainText(
    "Installed packages",
  );
});
