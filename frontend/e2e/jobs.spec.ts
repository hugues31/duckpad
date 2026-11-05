import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import { jobsFlow } from "./jobs-flow";

test("admins create and promote tagged Jobs; Operators confirm production runs and inspect read-only results", async ({
  page,
}) => {
  await signIn(page);
  await jobsFlow(page);
});

test("creates a scoped Job without tags and shows external scheduling examples", async ({
  page,
}) => {
  await signIn(page);
  const tree = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  await page.goto(`/projects/${tree.project}/jobs`);
  const empty = page.locator(".empty-state");
  await expect(empty).toContainText("A Job runs a chosen version");
  await empty.getByRole("button", { name: "New Job", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New Job", exact: true });
  await expect(dialog.getByLabel("Name", { exact: true })).toBeFocused();
  await dialog.getByLabel("Name", { exact: true }).fill("Daily revenue");
  await expect(dialog.getByLabel("Slug", { exact: true })).toHaveValue(
    "daily-revenue",
  );
  const slug = `daily-revenue-${Date.now()}`;
  await dialog.getByLabel("Slug", { exact: true }).fill(slug);
  await dialog.getByLabel("Name", { exact: true }).fill("Daily revenue job");
  await expect(dialog.getByLabel("Slug", { exact: true })).toHaveValue(slug);
  await expect(dialog.getByLabel("Target", { exact: true })).toHaveValue(
    "branch",
  );
  await expect(dialog.getByLabel("Version", { exact: true })).toHaveValue(
    "main",
  );
  await dialog
    .getByRole("combobox", { name: "Scope", exact: true })
    .fill("Orders");
  await dialog.getByRole("option", { name: "Orders", exact: true }).click();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".job-details")).toContainText("Scope: Orders");
  const automation = page.locator(".job-details details[open]");
  await expect(automation).toContainText(
    `${new URL(page.url()).origin}/api/v1/jobs/${slug}/runs`,
  );
  await expect(automation).toContainText(`duckpad run ${slug}`);
  const job = await (await page.request.get(`/api/jobs/${slug}`)).json();
  expect(job.scope).toBe("orders");
  expect(job.target.kind).toBe("branch");
});
