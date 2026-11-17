import { expect, test, type Page } from "@playwright/test";
import type { Snapshot, Worktree } from "../src/types";
import { signIn } from "./helpers";

/** A project version that binds a parameter to a variable, tagged v1, and two Jobs on it. */
async function prepare(page: Page, suffix: string) {
  const tree: Worktree = await (
    await page.request.post("/api/projects", {
      data: { name: `Scenario acceptance ${suffix}` },
    })
  ).json();
  const snapshot: Snapshot = await (
    await page.request.get(`/api/worktrees/${tree.id}`)
  ).json();
  const bundle = snapshot.bundle!;
  bundle.flow.nodes = [
    {
      id: "orders",
      template: "orders",
      params: { amount: { $var: "batch_size" } },
      position: { x: 80, y: 80 },
    },
  ];
  bundle.flow.edges = [];
  bundle.templates.orders =
    "-- @param amount: number = 1\n-- @output result\nSELECT {{ amount }} AS amount;";
  bundle.variables = {
    batch_size: {
      type: "number",
      default: 10,
      environments: {},
      description: "Orders per batch",
    },
  };
  const saved = await page.request.put(`/api/worktrees/${tree.id}`, {
    data: { revision: snapshot.revision, bundle },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  const tag = await page.request.post(`/api/worktrees/${tree.id}/git/tags`, {
    data: { name: "v1", commit: (await saved.json()).commit, message: "" },
  });
  expect(tag.ok(), await tag.text()).toBeTruthy();
  for (const [slug, name, environment] of [
    [`load-${suffix}`, "Load orders", "dev"],
    [`publish-${suffix}`, "Publish report", "prod"],
  ])
    expect(
      (
        await page.request.post(`/api/projects/${tree.project}/jobs`, {
          data: {
            slug,
            name,
            environment,
            target: { kind: "tag", ref: "v1" },
          },
        })
      ).ok(),
    ).toBeTruthy();
  return tree;
}

test("an admin chains Jobs in a scenario, runs it with a launch value and reads its history", async ({
  page,
}) => {
  await signIn(page);
  const suffix = Date.now().toString();
  const tree = await prepare(page, suffix);
  await page.goto(`/worktrees/${tree.id}/flow`);
  await page.getByRole("link", { name: "Jobs", exact: true }).click();
  await page
    .locator(".page-heading")
    .getByRole("button", { name: "New scenario", exact: true })
    .click();
  const form = page.getByRole("dialog", { name: "New scenario", exact: true });
  await form.getByLabel("Name", { exact: true }).fill(`Nightly ${suffix}`);
  await expect(form.getByLabel("Job of step 1")).toHaveValue(`load-${suffix}`);
  await form.getByRole("button", { name: "Add step", exact: true }).click();
  await form.getByLabel("Job of step 2").selectOption(`publish-${suffix}`);
  await expect(form.getByLabel("Condition of step 2")).toHaveValue("success");
  await form.getByRole("checkbox", { name: /batch_size/ }).check();
  await form.getByRole("button", { name: "Add schedule", exact: true }).click();
  await form.getByLabel("Cron expression 1").fill("30 2 * * 1-5");
  await form.getByLabel("Time zone", { exact: true }).selectOption("UTC");
  await expect(form.getByText(/^Next:/)).toBeVisible();
  await form.getByLabel("Cron expression 1").fill("30 25 * * *");
  await expect(form.getByText("The hour field accepts 0 to 23")).toBeVisible();
  await form.getByLabel("Cron expression 1").fill("30 2 * * 1-5");
  await form.getByLabel("Accept webhook deliveries").check();
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(form).toHaveCount(0);
  const details = page.getByRole("region", { name: `Nightly ${suffix}` });
  await expect(details.getByText("Load orders")).toBeVisible();
  await expect(details.getByText("If previous steps succeeded")).toBeVisible();
  await expect(details.getByText("30 2 * * 1-5")).toBeVisible();

  await details
    .getByRole("button", { name: "Run scenario", exact: true })
    .click();
  const launch = page.getByRole("dialog", {
    name: "Run scenario",
    exact: true,
  });
  await launch.getByLabel("batch_size").fill("42");
  await launch
    .getByRole("button", { name: "Run scenario", exact: true })
    .click();
  // The second step runs in prod, which asks a person to confirm.
  const confirm = page.getByRole("dialog", {
    name: "Run scenario",
    exact: true,
  });
  await expect(confirm.getByText("prod", { exact: true })).toBeVisible();
  await confirm
    .getByRole("button", { name: "Run scenario", exact: true })
    .click();
  const row = details.locator(".scenario-run").first();
  await expect(row.locator(".history-row .badge")).toHaveText("Succeeded", {
    timeout: 30000,
  });
  await row.locator(".history-row").click();
  await expect(row.getByText("batch_size")).toBeVisible();
  await expect(row.locator(".scenario-step-runs .badge")).toHaveText([
    "Succeeded",
    "Succeeded",
  ]);
  await row.getByRole("button", { name: "Run details" }).first().click();
  const run = page.getByRole("dialog", { name: "View execution" });
  await expect(
    run.getByText(`Nightly ${suffix}`, { exact: true }),
  ).toBeVisible();
  await expect(run.getByText("launch", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(run).toHaveCount(0);

  // A webhook delivery starts one run, however often it is repeated.
  const slug = `nightly-${suffix}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const delivered = await page.request.post(
      `/api/v1/scenarios/${slug}/webhook`,
      {
        headers: { "Webhook-Id": `delivery-${suffix}` },
        data: { parameters: { batch_size: 7 } },
      },
    );
    expect(delivered.status()).toBe(202);
  }
  await expect(details.locator(".scenario-run")).toHaveCount(2);
  await expect(details.locator(".scenario-run").first()).toContainText(
    "Webhook",
  );
});
