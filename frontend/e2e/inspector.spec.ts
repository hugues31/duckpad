import { test, expect, type Page } from "@playwright/test";
import { createFilterProject, deferred, signIn } from "./helpers";
import type { Snapshot } from "../src/types";
import fr from "../src/locales/fr.json" with { type: "json" };

async function openInspector(page: Page) {
  await signIn(page);
  const response = await page.request.post("/api/example", { data: {} });
  expect(response.ok()).toBeTruthy();
  const worktree = await response.json();
  const endpoint = `/api/worktrees/${worktree.id}`;
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Paid orders", { exact: true }) })
    .click();
  const inspector = page.locator(".inspector");
  return {
    endpoint,
    inspector,
    label: inspector.getByRole("textbox", {
      name: "Display name",
      exact: true,
    }),
    status: inspector.getByRole("textbox", { name: /status/ }),
  };
}

async function delayFirstSave(page: Page, endpoint: string, fail = false) {
  const started = deferred();
  const release = deferred();
  const requests: { revision: string; bundle: Snapshot["bundle"] }[] = [];
  const responses: Snapshot[] = [];
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    requests.push(route.request().postDataJSON());
    const first = requests.length === 1;
    if (first && fail) {
      started.resolve();
      await release.promise;
      return route.fulfill({
        status: 503,
        json: { error: "Temporary save failure" },
      });
    }
    const response = await route.fetch();
    expect(response.ok()).toBeTruthy();
    responses.push(await response.json());
    if (first) {
      started.resolve();
      await release.promise;
    }
    await route.fulfill({ response });
  });
  return {
    started: started.promise,
    release: release.resolve,
    requests,
    responses,
  };
}

test("Inspector saves edits after a pause, then edits typed during that save", async ({
  page,
}) => {
  const { endpoint, inspector, label, status } = await openInspector(page);
  await expect(
    inspector.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveCount(0);
  const pending = await delayFirstSave(page, endpoint);
  // No blur: the pause in typing saves the label.
  await label.fill("Reviewed orders");
  await pending.started;
  await expect(page.locator(".save-status")).toHaveText("Saving…");
  await status.fill("refunded");
  pending.release();
  await expect(inspector.locator(".inspector-title")).toContainText(
    "Reviewed orders",
  );
  await expect.poll(() => pending.responses.length).toBe(2);
  expect(pending.requests[1].revision).toBe(pending.responses[0].revision);
  await expect(page.locator(".save-status")).toHaveText("All changes saved");
  await page.reload();
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "Reviewed orders" })
    .click();
  await expect(status).toHaveValue("refunded");
  await expect(inspector.locator(".notice.error")).toHaveCount(0);
});

test("Inspector queues a save requested during an earlier save using its new revision", async ({
  page,
}) => {
  const { endpoint, inspector, label, status } = await openInspector(page);
  const pending = await delayFirstSave(page, endpoint);
  await label.fill("First label");
  await label.blur();
  await pending.started;
  // Editing the same field again would conflict if the next save used the old revision.
  await label.fill("Latest label");
  await label.blur();
  expect(pending.requests).toHaveLength(1);
  pending.release();
  await expect(inspector.locator(".inspector-title")).toContainText(
    "Latest label",
  );
  expect(pending.requests).toHaveLength(2);
  expect(pending.requests[1].revision).toBe(pending.responses[0].revision);
  await status.fill("refunded");
  await status.blur();
  await expect.poll(() => pending.responses.length).toBe(3);
  expect(pending.requests[2].revision).toBe(pending.responses[1].revision);
  await page.reload();
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "Latest label" })
    .click();
  await expect(label).toHaveValue("Latest label");
  await expect(status).toHaveValue("refunded");
  await expect(inspector.locator(".notice.error")).toHaveCount(0);
});

test("Inspector sends one PUT when a field blurs during its pause save", async ({
  page,
}) => {
  const { endpoint, inspector, label } = await openInspector(page);
  const pending = await delayFirstSave(page, endpoint);
  await label.fill("Saved once");
  await pending.started;
  await label.blur();
  pending.release();
  await expect(inspector.locator(".inspector-title")).toContainText(
    "Saved once",
  );
  await expect(page.locator(".save-status")).toHaveText("All changes saved");
  expect(pending.requests).toHaveLength(1);
  await expect(inspector.locator(".notice.error")).toHaveCount(0);
});

test("Inspector preserves the latest draft after a failed save and allows retry", async ({
  page,
}) => {
  const { endpoint, inspector, label } = await openInspector(page);
  const pending = await delayFirstSave(page, endpoint, true);
  await label.fill("First attempt");
  await label.blur();
  await pending.started;
  await label.fill("Retry with latest edits");
  // Let the pause save of the new text join the failing save first.
  await page.waitForTimeout(1500);
  pending.release();
  await expect(inspector.locator(".notice.error")).toHaveText(
    "Temporary save failure",
  );
  await expect(page.locator(".save-status")).toHaveText("Unsaved changes");
  await expect(label).toHaveValue("Retry with latest edits");
  expect(pending.requests).toHaveLength(1);
  await label.blur();
  await expect(inspector.locator(".inspector-title")).toContainText(
    "Retry with latest edits",
  );
  await expect(inspector.locator(".notice.error")).toHaveCount(0);
  expect(pending.requests).toHaveLength(2);
  await page.reload();
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "Retry with latest edits" })
    .click();
  await expect(label).toHaveValue("Retry with latest edits");
});

test("Info tab tells who changed the node and opens its history", async ({
  page,
}) => {
  const { endpoint, inspector, label } = await openInspector(page);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(endpoint) &&
      response.request().method() === "PUT",
  );
  await label.fill("Reviewed orders");
  await label.blur();
  const snapshot: Snapshot = await (await saved).json();
  const node = snapshot.bundle!.flow.nodes.find(
    (n) => n.label === "Reviewed orders",
  )!;
  await inspector.getByRole("button", { name: "Info", exact: true }).click();
  const changes = inspector.getByRole("region", { name: "Changes" });
  const last = changes.locator("dt", { hasText: "Last modified" });
  await expect(last.locator("+ dd")).toContainText("now by admin");
  await expect(last.locator("+ dd")).toContainText("Documentation");
  await expect(changes.locator("dt", { hasText: "Created" })).toBeVisible();
  await expect(
    changes.locator("dt", { hasText: "Contributors" }).locator("+ dd"),
  ).toHaveText("admin");
  const details = inspector.getByRole("region", { name: "Details" });
  await expect(details).toContainText(node.id);
  await expect(details).toContainText(`templates/${node.template}.sql`);

  const revisions = await changes
    .locator("dt", { hasText: "Revisions" })
    .locator("+ dd")
    .innerText();
  await changes
    .getByRole("button", { name: "View change history", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Project Git workspace" });
  await expect(dialog.getByLabel("History element")).toHaveValue(
    `node/${node.id}`,
  );
  await expect(dialog.locator(".git-commit").first()).toContainText("admin");
  // The history lists exactly the commits counted as revisions.
  await expect(dialog.locator(".git-commit")).toHaveCount(Number(revisions));
});

test("the result summary opens the matching tab of the results panel", async ({
  page,
}) => {
  const { endpoint, inspector } = await openInspector(page);
  await expect(inspector.locator(".inspector-tabs button")).toHaveText([
    "Parameters",
    "SQL",
    "Documentation",
    "Info",
  ]);
  const summary = inspector.getByRole("group", {
    name: "Result summary",
    exact: true,
  });
  await expect(summary).toContainText("No result yet");
  // Run outcomes left the inspector: no executed SQL, no dataset documentation.
  await inspector.getByRole("button", { name: "SQL", exact: true }).click();
  await expect(
    inspector.getByRole("button", { name: "Displayed result" }),
  ).toHaveCount(0);
  await inspector
    .getByRole("button", { name: "Documentation", exact: true })
    .click();
  await expect(inspector.getByRole("combobox")).toHaveCount(0);
  await expect(
    inspector.getByRole("textbox", { name: "Node documentation" }),
  ).toBeVisible();

  const launched = await (
    await page.request.post(`${endpoint}/runs`, {
      data: { environment: "dev" },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${launched.id}`)).json())
          .status,
      { timeout: 45000 },
    )
    .toBe("success");
  const results = page.getByRole("region", { name: "Results", exact: true });
  const tab = (name: string) =>
    results.getByRole("tab", { name: new RegExp(`^${name}`) });
  await expect(summary.locator(".badge")).toHaveText("Valid");
  await summary.getByRole("button", { name: /^Run at / }).click();
  await expect(tab("Log")).toHaveAttribute("aria-selected", "true");
  await summary.getByRole("button", { name: "2 outputs", exact: true }).click();
  await expect(tab("Data")).toHaveAttribute("aria-selected", "true");
  await results
    .getByRole("button", { name: "Hide results", exact: true })
    .click();
  await expect(results).toBeHidden();
  await summary.getByRole("button", { name: "Results", exact: true }).click();
  await expect(results).toBeVisible();

  // A component instance shows the results of the nodes computing its outputs.
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Regional revenue", { exact: true }) })
    .click();
  await expect(summary.locator(".badge")).toHaveText("Valid");
  await expect(results.locator(".results-header .badge")).toHaveText("Valid");
  await summary.getByRole("button", { name: /^Run at / }).click();
  await expect(results.locator(".log-timeline")).toContainText("Published");
});

test("input choices use the names shown on the canvas", async ({ page }) => {
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "Source names" },
    })
  ).json();
  await page.goto(`/worktrees/${worktree.id}/flow`);
  const nodes = page.locator(".react-flow__node");
  const add = async (label: string) => {
    await page.getByRole("button", { name: label, exact: true }).click();
    return nodes
      .filter({ has: page.getByText(label, { exact: true }) })
      .getAttribute("data-id");
  };
  const csv = await add("Load CSV");
  const parquet = await add("Load Parquet");
  const filter = await add("Filter");
  const input = page.locator(".inspector").getByLabel("source", {
    exact: true,
  });
  const choices = input.locator('option:not([value=""])');
  await expect(choices).toHaveText([
    "Load CSV · result",
    "Load Parquet · result",
  ]);
  // Option values keep the node and port identifiers.
  await input.selectOption({ label: "Load Parquet · result" });
  await expect(input).toHaveValue(`${parquet}:result`);
  await expect
    .poll(async () => {
      const snapshot: Snapshot = await (
        await page.request.get(`/api/worktrees/${worktree.id}`)
      ).json();
      return snapshot.bundle!.flow.edges.find((e) => e.target === filter);
    })
    .toMatchObject({ source: parquet, sourceHandle: "result" });
  // The results panel offers the same name among the inputs to compare.
  const compared = page.locator('.dataset-select option[value="input:source"]');
  await expect(compared).toContainText("source ← Load Parquet · result");

  // A display name takes priority over the translated default.
  await page.getByRole("button", { name: "Fit view", exact: true }).click();
  await page.locator(`.react-flow__node[data-id="${csv}"] .node-shape`).click();
  const label = page
    .locator(".inspector")
    .getByRole("textbox", { name: "Display name", exact: true });
  await label.fill("Order codes");
  await label.blur();
  await expect(page.locator(".save-status")).toHaveText("All changes saved");
  await page
    .locator(`.react-flow__node[data-id="${filter}"] .node-shape`)
    .click();
  await expect(choices).toHaveText([
    "Order codes · result",
    "Load Parquet · result",
  ]);

  await page.locator(".account .avatar").click();
  await page
    .getByRole("menuitemradio", { name: "French", exact: true })
    .click();
  await expect(choices).toHaveText([
    "Order codes · result",
    `${fr.load_parquet} · result`,
  ]);
  await expect(nodes.filter({ hasText: fr.load_parquet })).toHaveCount(1);
  await expect(compared).toContainText(`source ← ${fr.load_parquet} · result`);
});

test("the Inspector translates builtin titles and names a missing template", async ({
  page,
}) => {
  const { endpoint, read } = await createFilterProject(page);
  await page.evaluate(() => localStorage.setItem("duckpad-language", "fr"));
  await page.reload();
  await expect(page.locator(".inspector-title")).toContainText(fr.filter);
  const snapshot = await read();
  snapshot.bundle!.flow.nodes.find((node) => node.id === "filtered")!.template =
    "missing_template";
  await page.request.put(endpoint, {
    data: { revision: snapshot.revision, bundle: snapshot.bundle },
  });
  await expect(page.locator(".inspector-title")).toContainText(
    "missing_template",
  );
});

test("binding diagnostics distinguish overlapping parameter names", async ({
  page,
}) => {
  await createFilterProject(page, (bundle) => {
    bundle.templates.paths =
      '-- @label Paths\n-- @input source\n-- @param file: text = ""\n-- @param file_name: text = ""\n-- @output result\nSELECT * FROM {{ source }};';
    const node = bundle.flow.nodes.find((node) => node.id === "filtered")!;
    node.template = "paths";
    node.params = { file: { $var: "path" }, file_name: { $var: "count" } };
    bundle.variables = {
      path: { type: "text", default: "data.csv" },
      count: { type: "number", default: 1 },
    };
  });
  const inspector = page.locator(".inspector");
  await expect(inspector.locator(".variable-binding")).toHaveCount(2);
  await expect(inspector.locator(".variable-binding").first()).not.toHaveClass(
    /has-error/,
  );
  await expect(inspector.locator(".variable-binding").last()).toHaveClass(
    /has-error/,
  );
});

test("a conflict opened from the banner while editing resolves once and leaves the field clean", async ({
  page,
}) => {
  const { endpoint, read } = await createFilterProject(page);
  // A collaborator renames the node the page still shows at its old revision.
  const remote = await read();
  remote.bundle!.flow.nodes.find((node) => node.id === "filtered")!.label =
    "Theirs";
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: remote.revision, bundle: remote.bundle },
      })
    ).ok(),
  ).toBe(true);
  const inspector = page.locator(".inspector");
  await inspector.getByLabel("Display name", { exact: true }).fill("Mine");
  const resolve = page.getByRole("button", {
    name: "Save resolution",
    exact: true,
  });
  // Still in the field: opening the conflict blurs it.
  await resolve.click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Use my proposal", exact: true })
    .click();
  await expect(page.locator(".save-status")).toHaveText("All changes saved");
  await expect(resolve).toHaveCount(0);
  await expect(inspector.locator(".notice.error")).toHaveCount(0);
  const resolved = await read();
  expect(resolved.conflicts).toEqual([]);
  expect(
    resolved.bundle!.flow.nodes.find((node) => node.id === "filtered")!.label,
  ).toBe("Mine");
});
