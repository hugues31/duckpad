import { expect, type Page } from "@playwright/test";
import type { Snapshot, Worktree } from "../src/types";
import en from "../src/locales/en.json" with { type: "json" };

/** Exercise the production UI against a disposable project, locally or in a preview. */
export async function jobsFlow(page: Page) {
  const suffix = Date.now().toString();
  const slug = `daily-${suffix}`;
  const tree: Worktree = await (
    await page.request.post("/api/projects", {
      data: { name: `Job acceptance ${suffix}` },
    })
  ).json();
  const save = async (value: number) => {
    const snapshot: Snapshot = await (
      await page.request.get(`/api/worktrees/${tree.id}`)
    ).json();
    const bundle = snapshot.bundle!;
    bundle.flow.nodes = [
      {
        id: "source",
        template: "job_source",
        params: { amount: { $var: "batch_size" } },
        position: { x: 80, y: 80 },
      },
    ];
    bundle.flow.edges = [];
    bundle.templates.job_source =
      "-- @kind source\n-- @param amount: number = 1\n-- @output result\nSELECT {{ amount }} AS value;";
    bundle.variables = {
      batch_size: {
        type: "number",
        default: value,
        environments: {},
        description: "Batch size",
      },
    };
    const result = await page.request.put(`/api/worktrees/${tree.id}`, {
      data: { revision: snapshot.revision, bundle },
    });
    expect(result.ok(), await result.text()).toBeTruthy();
    const next: Snapshot = await result.json();
    const tag = await page.request.post(`/api/worktrees/${tree.id}/git/tags`, {
      data: {
        name: `v${value}`,
        commit: next.commit,
        message: "Acceptance passed",
      },
    });
    expect(tag.ok(), await tag.text()).toBeTruthy();
    return next.commit;
  };
  const first = await save(10);
  await page.goto(`/worktrees/${tree.id}/flow`);
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  await page.getByRole("button", { name: "New Job", exact: true }).click();
  let dialog = page.getByRole("dialog", { name: "New Job", exact: true });
  await dialog.getByLabel("Slug", { exact: true }).fill(slug);
  await dialog.getByLabel("Name", { exact: true }).fill("Daily production");
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("Accepted production version");
  await dialog.getByLabel("Environment", { exact: true }).selectOption("prod");
  await dialog.getByLabel("Version", { exact: true }).selectOption("v10");
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Daily production", exact: true }),
  ).toBeVisible();
  const job = await (await page.request.get(`/api/jobs/${slug}`)).json();
  expect(job.target.commit).toBe(first);
  // An admin must see the comparison, including variables, before promotion.
  const second = await save(20);
  await page
    .getByRole("button", { name: "Change version", exact: true })
    .click();
  dialog = page.getByRole("dialog", { name: "Change version", exact: true });
  await expect(
    dialog.getByRole("button", { name: "Use this version", exact: true }),
  ).toBeDisabled();
  await dialog.getByLabel("Version", { exact: true }).selectOption("v20");
  await expect(
    dialog.getByRole("heading", { name: "Compare versions", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("batch_size", { exact: false }).first(),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Use this version", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(
    (await (await page.request.get(`/api/jobs/${slug}`)).json()).target.commit,
  ).toBe(second);
  await page.getByText("Version history", { exact: true }).click();
  await expect(page.locator(".job-details details")).toContainText("v10 → v20");

  const username = `operator-${suffix}`;
  const password = "job-acceptance-password";
  const user = await (
    await page.request.post("/api/users", { data: { username, password } })
  ).json();
  expect(
    (
      await page.request.put(
        `/api/projects/${tree.project}/members/${user.id}`,
        { data: { role: "operator" } },
      )
    ).ok(),
  ).toBeTruthy();
  await page.request.post("/api/logout");
  expect(
    (
      await page.request.post("/api/login", { data: { username, password } })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/projects/${tree.project}/jobs`);
  await page
    .getByRole("button", { name: "Daily production", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "New Job", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Change version", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Run Job", exact: true }).click();
  dialog = page.getByRole("dialog", { name: "Run Job", exact: true });
  await expect(dialog).toContainText("Confirm execution in environment");
  await dialog.getByRole("button", { name: "Run Job", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator(".job-details button.history-row").first(),
  ).toContainText(en.success);
  await page.screenshot({ path: "test-results/jobs.png", fullPage: true });
  const runs = await (await page.request.get(`/api/jobs/${slug}/runs`)).json();
  expect(runs[0].commit).toBe(second);
  expect(runs[0].requester.username).toBe(username);
  await page.locator(".job-details button.history-row").first().click();
  dialog = page.getByRole("dialog", { name: "View execution", exact: true });
  await expect(dialog).toContainText(username);
  await expect(dialog).toContainText("v20");
  await dialog.getByTitle("Close", { exact: true }).click();
  await page.getByRole("link", { name: "Open results", exact: true }).click();
  await expect(
    page.getByText(
      "Job results are read-only. Launch and manage this version from Jobs.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: en.run, exact: true }),
  ).toBeDisabled();
  const preview = await page.request.get(
    `/api/worktrees/${job.worktree}/preview/source?environment=prod`,
  );
  expect(preview.ok(), await preview.text()).toBeTruthy();
  expect((await preview.json()).rows[0].values).toEqual([20]);
  await page.goto(`/worktrees/${tree.id}/history`);
  await expect(page.locator("button.history-row").first()).toContainText(
    "Daily production",
  );
  await expect(
    page.getByRole("button", { name: en.run, exact: true }),
  ).toBeDisabled();
  return { tree, job, run: runs[0] };
}
