import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./helpers";
import type { Snapshot } from "../src/types";

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
    save: inspector.getByRole("button", { name: "Save changes", exact: true }),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
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

test("Inspector keeps edits typed during a save and saves them on the next blur", async ({
  page,
}) => {
  const { endpoint, inspector, label, status } = await openInspector(page);
  const pending = await delayFirstSave(page, endpoint);
  await label.fill("Reviewed orders");
  await label.press("Tab");
  await pending.started;
  await status.fill("refunded");
  pending.release();
  await expect(inspector.locator(".inspector-title")).toContainText(
    "Reviewed orders",
  );
  await expect(status).toHaveValue("refunded");
  expect(pending.requests).toHaveLength(1);

  await status.blur();
  await expect.poll(() => pending.responses.length).toBe(2);
  expect(pending.requests[1].revision).toBe(pending.responses[0].revision);
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
  const { endpoint, inspector, label, status, save } =
    await openInspector(page);
  const pending = await delayFirstSave(page, endpoint);
  await label.fill("First label");
  await label.blur();
  await pending.started;
  // Editing the same field again would conflict if the next save used the old revision.
  await label.fill("Latest label");
  await save.click();
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

test("Inspector sends one PUT when Save changes blurs the edited field", async ({
  page,
}) => {
  const { endpoint, inspector, label, save } = await openInspector(page);
  const pending = await delayFirstSave(page, endpoint);
  await label.fill("Saved once");
  await save.click();
  await pending.started;
  pending.release();
  await expect(inspector.locator(".inspector-title")).toContainText(
    "Saved once",
  );
  await save.click();
  expect(pending.requests).toHaveLength(1);
  await expect(inspector.locator(".notice.error")).toHaveCount(0);
});

test("Inspector preserves the latest draft after a failed save and allows retry", async ({
  page,
}) => {
  const { endpoint, inspector, label, save } = await openInspector(page);
  const pending = await delayFirstSave(page, endpoint, true);
  await label.fill("First attempt");
  await label.blur();
  await pending.started;
  await label.fill("Retry with latest edits");
  pending.release();
  await expect(inspector.locator(".notice.error")).toHaveText(
    "Temporary save failure",
  );
  await expect(label).toHaveValue("Retry with latest edits");
  await save.click();
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

test("Inspector does not queue later edits for a duplicate blur and click save", async ({
  page,
}) => {
  const { endpoint, inspector, label, status, save } =
    await openInspector(page);
  const pending = await delayFirstSave(page, endpoint);
  await label.fill("Saved before more typing");
  await save.click();
  await pending.started;
  await status.fill("refunded");
  pending.release();
  await expect(inspector.locator(".inspector-title")).toContainText(
    "Saved before more typing",
  );
  await expect(page.locator(".save-status")).toHaveText("All changes saved");
  await expect(status).toHaveValue("refunded");
  expect(pending.requests).toHaveLength(1);
  await status.blur();
  await expect.poll(() => pending.responses.length).toBe(2);
  expect(pending.requests[1].revision).toBe(pending.responses[0].revision);
  await page.reload();
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "Saved before more typing" })
    .click();
  await expect(status).toHaveValue("refunded");
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
    .getByRole("button", { name: "Hide data preview", exact: true })
    .click();
  await expect(results).toBeHidden();
  await summary.getByRole("button", { name: "Results", exact: true }).click();
  await expect(results).toBeVisible();
});
