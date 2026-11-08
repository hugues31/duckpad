import { expect, test, type Page } from "@playwright/test";
import { signIn, withoutExampleVariables } from "./helpers";
import type { Run, Snapshot } from "../src/types";

async function prepare(page: Page, environment = "dev") {
  await signIn(page);
  const created = await page.request.post("/api/example", { data: {} });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  const endpoint = `/api/worktrees/${id}`;
  const snapshot: Snapshot = await (await page.request.get(endpoint)).json();
  withoutExampleVariables(snapshot.bundle!);
  snapshot.bundle!.variables = {
    order_status: { type: "choice(paid|refunded|pending)", default: "paid" },
  };
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle: snapshot.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/worktrees/${id}/flow?environment=${environment}`);
  await page.locator('.react-flow__node[data-id="validated"]').click();
  return { id, endpoint };
}

async function bindStatus(page: Page) {
  const inspector = page.locator(".inspector");
  await inspector
    .getByRole("button", { name: "Bind status to a variable", exact: true })
    .click();
  await inspector.getByRole("button", { name: /^order_status/ }).click();
}

function runResponse(page: Page, endpoint: string) {
  return page.waitForResponse(
    (response) =>
      response.url().endsWith(`${endpoint}/runs`) &&
      response.request().method() === "POST",
  );
}

function pauseSave(page: Page, endpoint: string, status?: number) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const routed = page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    await released;
    if (status)
      await route.fulfill({ status, json: { error: "Save rejected" } });
    else await route.continue();
  });
  return { release, routed };
}

async function expectNewBinding(page: Page, id: string) {
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${id}`)).json()).status,
      { timeout: 30000 },
    )
    .toBe("success");
  const result = await (await page.request.get(`/api/runs/${id}`)).json();
  expect(result.variables).toMatchObject({
    order_status: { source: "default", value: "paid" },
  });
}

for (const entry of [
  "pipeline",
  "inspector",
  "results",
  "empty results",
] as const) {
  test(`${entry} waits for saves and suppresses duplicate clicks`, async ({
    page,
  }) => {
    const { id, endpoint } = await prepare(page);
    const gate = pauseSave(page, endpoint);
    await gate.routed;
    const requests: unknown[] = [];
    page.on("request", (request) => {
      if (
        request.url().endsWith(`${endpoint}/runs`) &&
        request.method() === "POST"
      )
        requests.push(request.postDataJSON());
    });
    try {
      await bindStatus(page);
      await expect(page.locator(".flow-toolbar .save-status")).toHaveText(
        "Saving…",
      );
      const button =
        entry === "pipeline"
          ? page.getByRole("button", { name: "Run all", exact: true })
          : page
              .locator(
                entry === "inspector"
                  ? ".inspector"
                  : entry === "results"
                    ? ".results-actions"
                    : ".preview-empty",
              )
              .getByRole("button", { name: "Run with ancestors", exact: true });
      await expect(button).toBeVisible();
      const launched = runResponse(page, endpoint);
      // Two events in one render also exercise the launch guard, before disabled updates.
      await button.evaluate((element: HTMLButtonElement) => {
        element.click();
        element.click();
      });
      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute("aria-busy", "true");
      await expect(button.locator(".spin")).toBeVisible();
      expect(requests).toEqual([]);
      gate.release();
      const response = await launched;
      expect(response.ok()).toBeTruthy();
      const run: Run = await response.json();
      await expectNewBinding(page, run.id);
      expect(requests).toHaveLength(1);
      if (entry !== "pipeline")
        expect(requests[0]).toMatchObject({ node: "validated" });
      expect(
        await (await page.request.get(`/api/runs?worktree=${id}`)).json(),
      ).toHaveLength(1);
    } finally {
      gate.release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}

for (const node of [false, true]) {
  test(`confirmed ${node ? "node" : "pipeline"} waits for the new binding`, async ({
    page,
  }) => {
    const { endpoint } = await prepare(page, "prod");
    const gate = pauseSave(page, endpoint);
    await gate.routed;
    try {
      await bindStatus(page);
      await (
        node
          ? page.locator(".inspector .run-node")
          : page.getByRole("button", { name: "Run all", exact: true })
      ).click();
      const dialog = page.getByRole("dialog", {
        name: "Confirm execution",
        exact: true,
      });
      const launched = runResponse(page, endpoint);
      await dialog
        .getByRole("button", { name: "Confirm and run", exact: true })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Loading…", exact: true }),
      ).toBeDisabled();
      await expect(
        page.getByRole("button", { name: "Run all", exact: true }),
      ).toHaveAttribute("aria-busy", "true");
      gate.release();
      const response = await launched;
      expect(response.ok()).toBeTruthy();
      expect(response.request().postDataJSON()).toMatchObject({
        environment: "prod",
        confirmed: true,
        ...(node ? { node: "validated" } : {}),
      });
      await expectNewBinding(page, (await response.json()).id);
      await expect(dialog).toHaveCount(0);
    } finally {
      gate.release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}

// Both statuses take the same path; the environment decides where the error shows.
for (const [environment, status] of [
  ["dev", 409],
  ["prod", 422],
] as const) {
  test(`${environment} does not run when a save fails with ${status}`, async ({
    page,
  }) => {
    const { endpoint } = await prepare(page, environment);
    const gate = pauseSave(page, endpoint, status);
    await gate.routed;
    const requests: string[] = [];
    page.on("request", (request) => {
      if (
        request.url().endsWith(`${endpoint}/runs`) &&
        request.method() === "POST"
      )
        requests.push(request.url());
    });
    try {
      await bindStatus(page);
      const button = page.getByRole("button", {
        name: "Run all",
        exact: true,
      });
      await button.click();
      if (environment === "prod")
        await page
          .getByRole("button", { name: "Confirm and run", exact: true })
          .click();
      await expect(button).toHaveAttribute("aria-busy", "true");
      gate.release();
      await expect(page.getByRole("alert")).toContainText("Save rejected");
      await expect(button).toBeEnabled();
      expect(requests).toEqual([]);
      // The rejected save settles after reloading the snapshot; a click before that joins it.
      await expect(page.locator(".save-status")).not.toHaveText("Saving…");
      // A corrected save can be retried; the failed attempt releases the launch guard.
      await page.unrouteAll({ behavior: "wait" });
      const launched = runResponse(page, endpoint);
      await (
        environment === "prod"
          ? page.getByRole("button", { name: "Confirm and run", exact: true })
          : button
      ).click();
      const response = await launched;
      expect(response.ok()).toBeTruthy();
      await expectNewBinding(page, (await response.json()).id);
    } finally {
      gate.release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}

test("Run persists unsaved Code edits before launching", async ({ page }) => {
  const { endpoint } = await prepare(page);
  const snapshot: Snapshot = await (await page.request.get(endpoint)).json();
  const flow = JSON.parse(snapshot.files["flow.json"]);
  flow.nodes.find(
    (node: { id: string }) => node.id === "validated",
  ).params.status = { $var: "order_status" };
  await page.getByRole("link", { name: "Code", exact: true }).click();
  await page.getByRole("treeitem", { name: "flow.json", exact: true }).click();
  // The file's new editor stays hidden, so focusing it fails, and reports no
  // changes until it is ready: wait until it shows the file.
  await expect(page.locator(".code-workspace .monaco-editor")).toContainText(
    '"edges"',
  );
  const editor = page.locator(".code-workspace .monaco-editor textarea");
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(
    (text) => navigator.clipboard.writeText(text),
    JSON.stringify(flow, null, 2),
  );
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.locator(".flow-toolbar .save-status")).toHaveText(
    "Unsaved changes",
  );
  const launched = runResponse(page, endpoint);
  await page.getByRole("button", { name: "Run all", exact: true }).click();
  const response = await launched;
  expect(response.ok()).toBeTruthy();
  await expectNewBinding(page, (await response.json()).id);
  await expect(page.locator(".flow-toolbar .save-status")).toHaveText(
    "All changes saved",
  );
});
