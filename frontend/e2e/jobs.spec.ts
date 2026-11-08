import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import { jobsFlow } from "./jobs-flow";

test("job history displays every loaded summary and requests older pages explicitly", async ({
  page,
}) => {
  await signIn(page);
  const tree = await (
    await page.request.post("/api/projects", {
      data: { name: "Paged job history" },
    })
  ).json();
  const slug = `history-${Date.now()}`;
  const created = await page.request.post(
    `/api/projects/${tree.project}/jobs`,
    {
      data: {
        slug,
        name: "History Job",
        environment: "dev",
        target: { kind: "branch", ref: "main" },
      },
    },
  );
  expect(created.ok()).toBe(true);
  const job = await created.json();
  const summaries = Array.from({ length: 51 }, (_, index) => ({
    id: `run-${index}`,
    status: "success",
    started: "2026-01-01T00:00:00Z",
    environment: "dev",
    commit: job.resolved_commit,
  }));
  const requests: string[] = [];
  await page.route(`**/api/jobs/${slug}/runs*`, (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    requests.push(cursor || "first");
    return route.fulfill({
      json: cursor ? summaries.slice(50) : summaries.slice(0, 50),
      headers: cursor ? {} : { "X-Next-Cursor": "older" },
    });
  });
  await page.goto(`/projects/${tree.project}/jobs`);
  await page.getByRole("button", { name: "History Job", exact: true }).click();
  const details = page.locator(".job-details");
  await expect(details.locator(".history-row")).toHaveCount(50);
  expect(requests).not.toContain("older");
  await details.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(details.locator(".history-row")).toHaveCount(51);
  await expect(
    details.getByRole("button", { name: "Load more", exact: true }),
  ).toHaveCount(0);
  expect(requests.filter((cursor) => cursor === "older")).toHaveLength(1);
});

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
