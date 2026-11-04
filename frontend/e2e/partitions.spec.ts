import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { signIn } from "./helpers";
import { partitionFlow } from "./partitions-flow";

test("inspect retained keys, unavailable previews and global collectors without executing", async ({
  page,
}) => {
  page.on("pageerror", (error) => {
    throw error;
  });
  await signIn(page);
  const created = await (
    await page.request.post("/api/projects", {
      data: { name: "Partitioned orders" },
    })
  ).json();
  const endpoint = `/api/worktrees/${created.id}`;
  const snapshot = await (await page.request.get(endpoint)).json();
  const saved = await page.request.put(endpoint, {
    data: { revision: snapshot.revision, bundle: partitionFlow },
  });
  expect(saved.ok()).toBeTruthy();
  await page.goto(
    `/worktrees/${created.id}/flow?environment=dev&node=transform`,
  );
  await expect(
    page.getByRole("button", { name: "Partition: Not calculated" }),
  ).toBeVisible();
  const panel = page.getByRole("region", { name: "Results", exact: true });
  await expect(panel).toContainText(
    "The partition key list is not calculated yet.",
  );
  await page.getByRole("button", { name: "Run pipeline", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/runs?worktree=${created.id}`)
          ).json()
        )[0]?.status,
    )
    .toBe("success");
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(3);
  const runs = await (
    await page.request.get(`/api/runs?worktree=${created.id}`)
  ).json();
  await panel.getByRole("button", { name: /^batch-011 · Valid/ }).click();
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Partition: batch-011", exact: true }),
  ).toBeVisible();
  await panel.getByRole("tab", { name: "Log", exact: true }).click();
  await expect(panel).toContainText("Executed SQL");
  await panel.getByRole("tab", { name: "Data", exact: true }).click();
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await page.screenshot({
    path: resolve("../docs/images/partitions.png"),
    animations: "disabled",
    style: ".resource-monitor { visibility: hidden !important; }",
  });
  await page.goto(`/worktrees/${created.id}/flow?environment=dev&node=source`);
  await panel.getByRole("button", { name: /^batch-011 · Valid/ }).click();
  await expect(panel).toContainText("not retained");
  await panel.getByRole("button", { name: "All", exact: true }).click();
  await expect(panel).toContainText(
    "Incomplete preview: 1 of 2 partitions retained.",
  );
  await expect(panel.locator(".results-identity .badge")).toHaveText(
    "Incomplete",
  );
  expect(
    (await (await page.request.get(`/api/runs?worktree=${created.id}`)).json())
      .length,
  ).toBe(runs.length);
  await page.goto(`/worktrees/${created.id}/flow?environment=dev&node=collect`);
  await expect(panel).toContainText("All partitions");
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(3);
  await panel
    .getByRole("button", {
      name: "Explain this value: amount, rows 1, 10",
      exact: true,
    })
    .click();
  const lineage = page.getByRole("dialog", {
    name: "How this value was calculated",
    exact: true,
  });
  await expect(lineage).toContainText(
    "Origin available; intermediate results for batch-011 are not retained.",
  );
  await page.screenshot({
    path: resolve("../docs/images/partition-lineage.png"),
    animations: "disabled",
    style: ".resource-monitor { visibility: hidden !important; }",
  });
  const replaying = page.waitForResponse(
    (response) =>
      response.url().endsWith("/runs") &&
      response.request().method() === "POST",
  );
  await lineage
    .getByRole("button", { name: "Run this key to explain", exact: true })
    .click();
  const replay = await (await replaying).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${replay.id}`)).json())
          .status,
    )
    .toBe("success");
  expect(replay.scope).toBe("transform");
  expect(replay.partition_selection.keys).toEqual([
    { type: "text", value: "batch-011" },
  ]);
  await expect(page).toHaveURL(/node=transform/);
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(2);
  await page
    .getByRole("button", { name: "Run with options…", exact: true })
    .click();
  const options = page.getByRole("dialog", {
    name: "Run with options…",
    exact: true,
  });
  await options.getByLabel("Key selection").selectOption("selected");
  await options
    .getByRole("checkbox", { name: "batch-011", exact: true })
    .uncheck();
  await options
    .getByRole("checkbox", { name: "batch-012", exact: true })
    .check();
  await options.getByLabel("Parallel partitions").fill("2");
  const launching = page.waitForResponse(
    (response) =>
      response.url().endsWith("/runs") &&
      response.request().method() === "POST",
  );
  await options
    .getByRole("button", { name: "Run pipeline", exact: true })
    .click();
  const launchResponse = await launching;
  expect(launchResponse.ok()).toBeTruthy();
  const launched = await launchResponse.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${launched.id}`)).json())
          .status,
    )
    .toBe("success");
  const latest = await (
    await page.request.get(`/api/runs/${launched.id}`)
  ).json();
  expect(latest.partition_selection.keys).toEqual([
    { type: "text", value: "batch-012" },
  ]);
  expect(latest.partitions.selected).toBe(1);
  await page.goto(
    `/worktrees/${created.id}/history?environment=dev&run=${latest.id}`,
  );
  await expect(
    page.getByRole("region", { name: "Partitions", exact: true }),
  ).toContainText("1/1");
});

test("Job history retries failed keys using the Job launch contract", async ({
  page,
}) => {
  await signIn(page);
  const created = await (
    await page.request.post("/api/projects", {
      data: { name: "Partition Job review" },
    })
  ).json();
  const endpoint = `/api/worktrees/${created.id}`;
  const snapshot = await (await page.request.get(endpoint)).json();
  const project = structuredClone(partitionFlow);
  project.templates.transform = project.templates.transform.replace(
    "d.amount * l.rate",
    "CASE WHEN d.amount = 2 THEN error('Synthetic partition failure') ELSE d.amount * l.rate END",
  );
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle: project },
      })
    ).ok(),
  ).toBeTruthy();
  const job = await (
    await page.request.post(`/api/projects/${created.project}/jobs`, {
      data: {
        slug: "partition-retry",
        name: "Partition retry",
        environment: "dev",
        target: { kind: "branch", ref: "main" },
      },
    })
  ).json();
  expect(job.slug).toBe("partition-retry");
  const first = await (
    await page.request.post(`/api/jobs/${job.slug}/runs`, { data: {} })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${first.id}`)).json()).status,
    )
    .toBe("partial_failure");
  await page.goto(`/projects/${created.project}/jobs`);
  await page
    .getByRole("button", { name: "Partition retry", exact: true })
    .click();
  await page.locator(".job-details button.history-row").first().click();
  const launching = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/jobs/${job.slug}/runs`) &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Run failed partitions", exact: true })
    .click();
  const response = await launching;
  expect(response.ok()).toBeTruthy();
  const retry = await response.json();
  expect(retry.partition_selection).toEqual({ mode: "failed" });
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${retry.id}`)).json()).status,
    )
    .toBe("failed");
  expect(
    (await (await page.request.get(`/api/runs/${retry.id}`)).json()).partitions
      .selected,
  ).toBe(1);
});

test("partition controls fit a laptop, preserve selection and explain failed keys", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await signIn(page);
  const created = await (
    await page.request.post("/api/projects", {
      data: { name: "Partition controls review" },
    })
  ).json();
  const endpoint = `/api/worktrees/${created.id}`;
  const snapshot = await (await page.request.get(endpoint)).json();
  const project = structuredClone(partitionFlow);
  project.flow.partitions!.batch.execution = { on_error: "continue" };
  project.flow.nodes.find((n) => n.id === "transform")!.params.value =
    "CASE WHEN {{ partition }} = 'batch-012' THEN error('Order conversion failed') ELSE {{ partition.task }} END";
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle: project },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(
    `/worktrees/${created.id}/flow?environment=dev&node=transform`,
  );
  const run = page.getByRole("button", { name: "Run pipeline", exact: true });
  const bounds = await run.boundingBox();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1366);
  await run.click();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/runs?worktree=${created.id}`)
          ).json()
        )[0]?.status,
    )
    .toBe("partial_failure");
  const panel = page.getByRole("region", { name: "Results", exact: true });
  await panel.getByRole("button", { name: /^batch-012 · Failed/ }).click();
  await expect(panel).toContainText("Order conversion failed");
  await expect(panel).not.toContainText("partition_not_retained:");
  await expect(
    page.locator('.react-flow__node[data-id="collect"] .node-status'),
  ).toContainText("Blocked");
  await page
    .getByRole("button", { name: "Partition: batch-012", exact: true })
    .click();
  await expect(page.locator(".partition-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".partition-menu")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Partition: batch-012", exact: true })
    .click();
  await page
    .locator(".partition-menu")
    .getByRole("button", { name: /^batch-011 ·/ })
    .click();
  await expect(page.locator(".partition-menu")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Partition: batch-011", exact: true })
    .click();
  await page.locator(".flow-toolbar").click({ position: { x: 1, y: 1 } });
  await expect(page.locator(".partition-menu")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Partition: batch-011", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Partition settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "Partition settings" });
  await expect(settings.getByLabel("Source node")).toHaveValue("keys");
  await expect(
    settings.getByLabel("Source node").locator("option:checked"),
  ).toHaveText("Batches to process");
  await expect(
    settings.getByLabel("Source column", { exact: true }),
  ).toHaveValue("batch");
  await expect(settings.getByLabel("Preview budget (MiB)")).toHaveValue("1024");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await run.click();
  await expect
    .poll(
      async () =>
        (
          await (
            await page.request.get(`/api/runs?worktree=${created.id}`)
          ).json()
        )[0]?.status,
    )
    .toBe("partial_failure");
  await expect(
    page.getByRole("button", { name: "Partition: batch-011", exact: true }),
  ).toBeVisible();
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(2);
  await page.goto(`/worktrees/${created.id}/history?environment=dev`);
  await page
    .getByRole("button", { name: /Partial failure/ })
    .first()
    .click();
  const history = page.getByRole("region", { name: "Partitions", exact: true });
  await expect(history.getByLabel("Node")).toHaveValue("transform");
  await page.goto(`/worktrees/${created.id}/flow?environment=dev&node=collect`);
  await expect(
    page.locator('.react-flow__node[data-id="transform"] .node-status'),
  ).toContainText("Failed");
  // A blocked collector tells which keys it waits for and retries only those.
  await expect(panel).toContainText(
    "Waiting for every partition: no valid result for batch-012.",
  );
  await expect(panel).not.toContainText("Ready when you are");
  const retryButtons = panel.getByRole("button", {
    name: "Run failed partitions",
    exact: true,
  });
  await expect(retryButtons).toHaveCount(2);
  const retrying = page.waitForResponse(
    (response) =>
      response.url().endsWith("/runs") &&
      response.request().method() === "POST",
  );
  await retryButtons.last().click();
  const retry = await (await retrying).json();
  expect(retry.partition_selection).toEqual({ mode: "failed" });
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${retry.id}`)).json()).status,
    )
    .toBe("failed");
});
