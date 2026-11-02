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
  const panel = page.getByRole("region", { name: "Results", exact: true });
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(3);
  const runs = await (
    await page.request.get(`/api/runs?worktree=${created.id}`)
  ).json();
  await panel.getByRole("button", { name: /^a · Valid/ }).click();
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Partition: a", exact: true }),
  ).toBeVisible();
  await panel.getByRole("tab", { name: "Log", exact: true }).click();
  await expect(panel).toContainText("Executed SQL");
  await panel.getByRole("tab", { name: "Data", exact: true }).click();
  await page.screenshot({
    path: resolve("../docs/images/partitions.png"),
    animations: "disabled",
    style: ".resource-monitor { visibility: hidden !important; }",
  });
  await page.goto(`/worktrees/${created.id}/flow?environment=dev&node=source`);
  await panel.getByRole("button", { name: /^a · Valid/ }).click();
  await expect(panel).toContainText("not retained");
  await panel.getByRole("button", { name: "All", exact: true }).click();
  await expect(panel).toContainText(
    "Incomplete preview: 1 of 2 partitions retained.",
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
    "Origin available; intermediate results of a not retained.",
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
    { type: "text", value: "a" },
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
  await options.getByRole("checkbox", { name: "a", exact: true }).uncheck();
  await options.getByRole("checkbox", { name: "b", exact: true }).check();
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
    { type: "text", value: "b" },
  ]);
  expect(latest.partitions.selected).toBe(1);
  await page.goto(
    `/worktrees/${created.id}/history?environment=dev&run=${latest.id}`,
  );
  await expect(
    page.getByRole("region", { name: "Partitions", exact: true }),
  ).toContainText("1/1");
});
