import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { signIn } from "./helpers";
import { partitionFlow } from "./partitions-flow";

test("inspect retained keys, unavailable previews and global collectors without executing", async ({
  page,
}) => {
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
});
