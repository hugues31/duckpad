import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";
import type { Snapshot } from "../src/types";
import { resolve } from "node:path";

const ORDER_STATUS = {
  type: "choice(paid|refunded|pending)",
  description: "Order status counted as revenue.",
  default: "paid",
};

test("calculate a control value, retain it for a targeted launch and show its provenance", async ({
  page,
}) => {
  test.setTimeout(60000);
  const { id, url } = await example(page, (bundle) => {
    bundle.templates.control =
      "-- @kind source\n-- @output result\nSELECT 'paid' AS status;";
    bundle.flow.nodes.push({
      id: "control",
      template: "control",
      label: "Run control",
      params: {},
      position: { x: 50, y: 450 },
    });
    bundle.variables = {
      order_status: {
        type: "choice(paid|refunded)",
        description: "Processing mode supplied by the control output.",
        from: { node: "control", column: "status" },
      },
    };
    bundle.flow.nodes.find((node) => node.id === "validated")!.params.status = {
      $var: "order_status",
    };
  });
  const declarations = (await snapshot(page, url)).bundle!.variables;
  await page.goto(`/worktrees/${id}/variables?environment=dev`);
  await page.getByRole("button", { name: "order_status", exact: true }).click();
  const editor = page.getByRole("complementary", { name: "order_status" });
  await expect(editor.getByLabel("Value source", { exact: true })).toHaveValue(
    "computed",
  );
  await expect(editor.getByLabel("Default value", { exact: true })).toHaveCount(
    0,
  );
  await expect(editor.getByLabel("Source node")).toHaveValue("control");
  const pending = await (
    await page.request.get(`${url}/variables/scope?environment=dev`)
  ).json();
  expect(pending.order_status.state).toBe("pending");
  await run(page, url, "dev");
  const row = page
    .locator(".variables-table")
    .getByRole("row")
    .filter({ hasText: "order_status" });
  await expect(row).toContainText("paid");
  await expect(row).toContainText("Retained value");
  await page.screenshot({
    path: resolve("../docs/images/computed-variables.png"),
    animations: "disabled",
    style: ".resource-monitor { visibility: hidden !important; }",
  });
  const retained = await (
    await page.request.get(
      `${url}/variables/scope?environment=dev&node=validated`,
    )
  ).json();
  expect(retained.order_status.resolution).toBe("retained");
  const launch = await page.request.post(`${url}/runs`, {
    data: { environment: "dev", node: "validated" },
  });
  expect(launch.ok()).toBeTruthy();
  const started = await launch.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${started.id}`)).json())
          .status,
    )
    .toBe("success");
  const finished = await (
    await page.request.get(`/api/runs/${started.id}`)
  ).json();
  expect(finished.nodes.control).toBeUndefined();
  expect(finished.variables.order_status.producer_run).toBe(
    retained.order_status.producer_run,
  );
  expect((await snapshot(page, url)).bundle!.variables).toEqual(declarations);
  await page.goto(`/worktrees/${id}/history?environment=dev`);
  await page.locator(".history-row").first().click();
  await expect(page.locator(".variable-values")).toContainText(
    "Retained value",
  );
  await expect(page.locator(".variable-values")).toContainText(
    "control.result.status",
  );
  await page.getByRole("link", { name: "Open source cell" }).click();
  await expect(
    page.getByRole("dialog", {
      name: "How this value was calculated",
      exact: true,
    }),
  ).toContainText("paid");

  // A protected launch confirms producers, even when that environment retains a value.
  await run(page, url, "prod");
  await page.goto(`/worktrees/${id}/flow?environment=prod&node=validated`);
  await page.getByRole("button", { name: "Run pipeline", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirm execution" });
  await expect(confirmation.locator(".variable-values")).toContainText(
    "Calculated at launch",
  );
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await page
    .locator(".inspector")
    .getByRole("button", { name: "Run with ancestors", exact: true })
    .click();
  await expect(confirmation.locator(".variable-values")).toContainText(
    "Retained value",
  );
  await expect(confirmation.locator(".variable-values")).toContainText(
    "control.result.status",
  );
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
});

/** The Northstar example, optionally changed through the API before it opens. */
async function example(
  page: Page,
  change?: (bundle: NonNullable<Snapshot["bundle"]>) => void,
) {
  await signIn(page);
  const response = await page.request.post("/api/example", {
    data: { name: "Northstar" },
  });
  expect(response.ok()).toBeTruthy();
  const worktree = await response.json();
  const url = `/api/worktrees/${worktree.id}`;
  if (change) await update(page, url, change);
  return { id: worktree.id as string, url };
}

async function snapshot(page: Page, url: string): Promise<Snapshot> {
  return (await page.request.get(url)).json();
}

async function update(
  page: Page,
  url: string,
  change: (bundle: NonNullable<Snapshot["bundle"]>) => void,
) {
  const current = await snapshot(page, url);
  change(current.bundle!);
  const response = await page.request.put(url, {
    data: { revision: current.revision, bundle: current.bundle },
  });
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as Snapshot;
}

/** Bind Paid orders to order_status, declared with the given environment values. */
const bindOrderStatus =
  (environments: Record<string, string> = {}) =>
  (bundle: NonNullable<Snapshot["bundle"]>) => {
    bundle.variables = { order_status: { ...ORDER_STATUS, environments } };
    bundle.flow.nodes.find((n) => n.id === "validated")!.params.status = {
      $var: "order_status",
    };
  };

async function run(page: Page, url: string, environment: string) {
  const started = await page.request.post(`${url}/runs`, {
    data: { environment },
  });
  expect(started.ok()).toBeTruthy();
  const execution = await started.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${execution.id}`)).json())
          .status,
      { timeout: 30000 },
    )
    .toBe("success");
}

/** The status of a node's first result in an environment. */
async function resultStatus(
  page: Page,
  url: string,
  environment: string,
  node: string,
) {
  const statuses = await (
    await page.request.get(`${url}/status?environment=${environment}`)
  ).json();
  return Object.values(statuses.nodes[node]?.outputs || {}).map(
    (output) => (output as { status: string }).status,
  )[0];
}

async function commits(page: Page, url: string) {
  return (await (await page.request.get(`${url}/git/history`)).json()).items
    .length as number;
}

function node(page: Page, label: string) {
  return page.locator(".react-flow__node").filter({
    has: page.getByText(label, { exact: true }),
  });
}

async function saved(page: Page) {
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
}

test("promote a constant to a variable, then reuse it on another node (workflows 1 and 2)", async ({
  page,
}) => {
  const { id, url } = await example(page, (bundle) => {
    bundle.variables = {
      oracle_schema: { type: "identifier", default: "DEMO" },
    };
    bundle.flow.nodes.push({
      id: "refunds",
      template: "validated_orders",
      label: "Refunded orders",
      params: { status: "refunded" },
      position: { x: 530, y: 420 },
    });
    bundle.flow.edges.push({
      id: "enriched_result_refunds_source",
      source: "enriched",
      target: "refunds",
      sourceHandle: "result",
      targetHandle: "source",
    });
  });
  await run(page, url, "dev");
  const before = await commits(page, url);
  await page.goto(`/worktrees/${id}/flow`);
  await node(page, "Paid orders").click();
  const inspector = page.locator(".inspector");
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  await inspector
    .getByRole("button", { name: "Bind status to a variable", exact: true })
    .click();
  const picker = inspector.getByRole("group", {
    name: "Bind status to a variable",
  });
  // An identifier cannot be bound to a text parameter.
  await expect(
    picker.getByRole("button", { name: /oracle_schema/ }),
  ).toBeDisabled();
  await expect(picker).toContainText("identifier · incompatible");
  await picker
    .getByRole("button", { name: "Create a variable from “paid”…" })
    .click();
  const dialog = page.getByRole("dialog", { name: "New variable" });
  await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue(
    "status",
  );
  await expect(dialog.getByLabel("Default value", { exact: true })).toHaveValue(
    "paid",
  );
  await dialog.getByLabel("Name", { exact: true }).fill("order_status");
  await dialog
    .getByLabel("Description", { exact: true })
    .fill("Order status counted as revenue.");
  await dialog
    .getByRole("button", { name: "Create and bind", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await saved(page);

  // One commit declares the variable and binds the parameter.
  let current = await snapshot(page, url);
  expect(current.bundle!.variables).toMatchObject({
    order_status: {
      type: "text",
      default: "paid",
      description: "Order status counted as revenue.",
    },
  });
  expect(
    current.bundle!.flow.nodes.find((n) => n.id === "validated")!.params.status,
  ).toEqual({ $var: "order_status" });
  expect(await commits(page, url)).toBe(before + 1);
  const bound = inspector.getByRole("group", {
    name: "status is bound to order_status",
  });
  await expect(bound).toContainText("= paid in dev");
  await expect(bound).toContainText("paid in every environment");
  // The value is unchanged, so the result stays valid.
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  expect(await resultStatus(page, url, "dev", "validated")).toBe("valid");

  await node(page, "Refunded orders").click();
  await inspector
    .getByRole("button", { name: "Bind status to a variable", exact: true })
    .click();
  await inspector.getByRole("button", { name: /^order_status/ }).click();
  await saved(page);
  await expect(
    inspector.getByRole("group", { name: "status is bound to order_status" }),
  ).toBeVisible();
  current = await snapshot(page, url);
  expect(
    current.bundle!.flow.nodes.find((n) => n.id === "refunds")!.params.status,
  ).toEqual({ $var: "order_status" });

  // The cross restores a fixed value, initialized with the current one.
  await inspector
    .getByRole("button", {
      name: "Use a fixed value instead of order_status",
      exact: true,
    })
    .click();
  await saved(page);
  await expect(inspector.getByRole("textbox", { name: "status" })).toHaveValue(
    "paid",
  );
  current = await snapshot(page, url);
  expect(
    current.bundle!.flow.nodes.find((n) => n.id === "refunds")!.params.status,
  ).toBe("paid");

  await page.getByRole("link", { name: "Variables", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: "order_status" });
  await expect(row).toContainText("1 node");
  await expect(
    page.getByRole("row").filter({ hasText: "oracle_schema" }),
  ).toContainText("Not used");
});

test("use a production value, confirm its run and explain it in History (workflows 3 and 6)", async ({
  page,
}) => {
  const { id, url } = await example(page, bindOrderStatus());
  await run(page, url, "dev");
  await run(page, url, "prod");
  await page.goto(`/worktrees/${id}/variables?environment=dev`);
  const table = page.locator(".variables-table");
  await expect(table.locator("th[aria-current]")).toHaveText("dev");
  await table.getByRole("button", { name: "order_status" }).click();
  const editor = page.getByRole("complementary", { name: "order_status" });
  const prod = editor.getByLabel("prod value", { exact: true });
  await expect(prod).toBeDisabled();
  await editor
    .getByRole("switch", { name: "Use the default value in prod" })
    .click();
  await expect(prod).toBeEnabled();
  await prod.selectOption("refunded");
  await expect(editor.getByRole("status")).toHaveText(
    "Saving marks Paid orders and 5 descendants as stale in prod. Nothing runs automatically.",
  );
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await saved(page);
  const row = table.getByRole("row").filter({ hasText: "order_status" });
  await expect(row.getByRole("cell").nth(3)).toHaveText("default");
  await expect(row.getByRole("cell").nth(4)).toHaveText("refunded");
  expect((await snapshot(page, url)).bundle!.variables).toMatchObject({
    order_status: { environments: { prod: "refunded" } },
  });

  // Only the production results that use the variable become stale.
  await expect
    .poll(() => resultStatus(page, url, "prod", "validated"))
    .toBe("stale");
  expect(await resultStatus(page, url, "prod", "enriched")).toBe("valid");
  expect(await resultStatus(page, url, "dev", "validated")).toBe("valid");

  await editor.getByRole("button", { name: /Paid orders/ }).click();
  await expect(page).toHaveURL(/\/flow\?environment=dev&node=validated/);
  await expect(
    page.locator(".inspector").getByRole("group", {
      name: "status is bound to order_status",
    }),
  ).toContainText("= paid in dev");
  await page.getByLabel("Environment", { exact: true }).selectOption("prod");
  await expect(page.locator(".preview-header .badge")).toHaveText("Stale");
  await expect(page.locator(".stale-reason")).toHaveText(
    "Variable order_status changed in prod: paid → refunded. Run to refresh.",
  );
  const inspector = page.locator(".inspector");
  await expect(
    inspector.getByRole("group", { name: "status is bound to order_status" }),
  ).toContainText("= refunded in prod");
  await inspector.getByRole("button", { name: "SQL", exact: true }).click();
  const variables = inspector.locator(".variable-values");
  await expect(variables).toContainText("order_status");
  await expect(variables).toContainText("refunded");
  await expect(variables).toContainText("prod value");

  await page.getByRole("button", { name: "Run pipeline", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirm execution" });
  await expect(confirmation).toContainText("Variables used by this run · prod");
  const listed = confirmation
    .getByRole("row")
    .filter({ hasText: "order_status" });
  await expect(listed).toContainText("refunded");
  await expect(listed).toContainText("prod value");
  await confirmation
    .getByRole("button", { name: "Confirm and run", exact: true })
    .click();
  await expect
    .poll(() => resultStatus(page, url, "prod", "validated"), {
      timeout: 30000,
    })
    .toBe("valid");

  await page.getByRole("link", { name: "History", exact: true }).click();
  await page
    .locator(".history-row")
    .filter({ hasText: "prod" })
    .first()
    .click();
  const details = page.getByRole("dialog", { name: "View execution" });
  const recorded = details.locator(".run-variables");
  await expect(recorded).toContainText("Variables");
  await expect(recorded).toContainText("order_status");
  await expect(recorded).toContainText("Paid orders · status");
  await expect(recorded).toContainText("refunded");
  await expect(recorded).toContainText("prod value");
});

test("try another value on a branch and compare it with main (workflow 5)", async ({
  page,
}) => {
  const { url } = await example(page, bindOrderStatus());
  const branch = await (
    await page.request.post(`${url}/branches`, {
      data: { name: "experiment/refunds" },
    })
  ).json();
  await page.goto(`/worktrees/${branch.id}/variables?variable=order_status`);
  const editor = page.getByRole("complementary", { name: "order_status" });
  await editor
    .getByLabel("Default value", { exact: true })
    .selectOption("refunded");
  await expect(editor.getByRole("status")).toContainText(
    "as stale in dev, prod",
  );
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await saved(page);
  await run(page, `/api/worktrees/${branch.id}`, "dev");
  // main is unchanged until a merge.
  expect((await snapshot(page, url)).bundle!.variables).toMatchObject({
    order_status: { default: "paid" },
  });

  await page
    .getByRole("button", { name: "Git synchronization", exact: true })
    .click();
  const git = page.getByRole("dialog", { name: "Project Git workspace" });
  await git
    .getByRole("button", { name: "Compare versions", exact: true })
    .first()
    .click();
  await git.getByLabel("A: reference").fill("main");
  await git.getByLabel("B: target").fill("experiment/refunds");
  const change = git.locator(".change-row").filter({ hasText: "order_status" });
  await expect(change).toContainText("Variable");
  await change.click();
  await expect(git.locator(".comparison-values")).toContainText("refunded");
  await expect(git.locator(".comparison-usages")).toHaveText(
    "Nodes using this variable: Paid orders (status)",
  );
  await expect(git.locator(".git-impact summary")).toContainText(
    "downstream elements",
  );
});

test("rename, delete, diagnostics, the Code file and read-only access", async ({
  page,
  browser,
  baseURL,
}) => {
  const { id, url } = await example(page);
  // Code creates variables.json when a project has none.
  await page.goto(`/worktrees/${id}/code`);
  await page
    .getByRole("button", { name: "Create variables.json", exact: true })
    .click();
  await expect(page.locator(".code-file-heading")).toContainText(
    "variables.json",
  );
  await page
    .locator(".code-toolbar")
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect
    .poll(async () => (await snapshot(page, url)).bundle!.variables)
    .toEqual({});

  await update(page, url, bindOrderStatus());
  await run(page, url, "dev");
  await page.goto(`/worktrees/${id}/variables`);
  await page.getByRole("button", { name: "New variable", exact: true }).click();
  const creation = page.getByRole("complementary", { name: "New variable" });
  await creation.getByLabel("Name", { exact: true }).fill("api_token");
  await expect(creation).toContainText("looks like a credential");
  await creation.getByLabel("Name", { exact: true }).fill("minimum_amount");
  await creation.getByLabel("Type", { exact: true }).selectOption("number");
  await creation.getByLabel("Default value", { exact: true }).fill("300");
  await creation.getByLabel("Default value", { exact: true }).blur();
  await creation.getByRole("button", { name: "Create", exact: true }).click();
  const minimum = page.getByRole("complementary", { name: "minimum_amount" });
  await expect(minimum).toBeVisible();
  expect((await snapshot(page, url)).bundle!.variables).toMatchObject({
    minimum_amount: { type: "number", default: 300 },
  });
  await minimum.getByRole("button", { name: "Delete", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Delete variable" })
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  await expect(minimum).toBeHidden();
  expect((await snapshot(page, url)).bundle!.variables).not.toHaveProperty(
    "minimum_amount",
  );

  await page
    .locator(".variables-table")
    .getByRole("button", { name: "order_status" })
    .click();
  const editor = page.getByRole("complementary", { name: "order_status" });
  await expect(
    editor.getByRole("button", { name: "Delete", exact: true }),
  ).toBeDisabled();
  const before = await commits(page, url);
  await editor.getByRole("button", { name: "Rename…", exact: true }).click();
  const rename = page.getByRole("dialog", { name: "Rename variable" });
  await rename.getByLabel("Name", { exact: true }).fill("revenue_status");
  await rename.getByRole("button", { name: "Rename", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "revenue_status" }),
  ).toBeVisible();
  const renamed = await snapshot(page, url);
  expect(Object.keys(renamed.bundle!.variables as object)).toEqual([
    "revenue_status",
  ]);
  expect(
    renamed.bundle!.flow.nodes.find((n) => n.id === "validated")!.params.status,
  ).toEqual({ $var: "revenue_status" });
  expect(await commits(page, url)).toBe(before + 1);
  expect(await resultStatus(page, url, "dev", "validated")).toBe("valid");

  // Diagnostics appear on the variable, the binding and the toolbar banner.
  await update(page, url, (bundle) => {
    (bundle.variables as Record<string, any>).revenue_status.environments = {
      prod: "cancelled",
      staging: "paid",
    };
    bundle.flow.nodes.push({
      id: "orphan",
      template: "validated_orders",
      label: "Orphan orders",
      params: { status: { $var: "missing" } },
      position: { x: 530, y: 420 },
    });
  });
  const variable = page.getByRole("complementary", { name: "revenue_status" });
  await expect(variable.locator(".notice.error")).toContainText(
    "invalid value for prod",
  );
  await expect(variable.locator(".notice.warning")).toContainText(
    "which is not an environment of this instance",
  );
  await expect(variable).toContainText("staging");
  await expect(page.locator(".notice.warning").first()).toContainText(
    "missing is used by Orphan orders but is not declared.",
  );
  const prodCell = page
    .getByRole("row")
    .filter({ hasText: "revenue_status" })
    .getByRole("cell")
    .nth(4);
  await expect(prodCell).toHaveText("no value");
  await page.getByRole("link", { name: "Flow", exact: true }).click();
  await node(page, "Orphan orders").click();
  await expect(
    page
      .locator(".inspector")
      .getByRole("group", { name: "status is bound to missing" }),
  ).toContainText("This variable is not declared in variables.json.");
  await page
    .locator(".banner.error")
    .getByRole("button", { name: "Open in Variables" })
    .click();
  await expect(page).toHaveURL(/\/variables\?.*variable=revenue_status/);

  // Readers browse variables without editing them.
  const username = `variables-reader-${Date.now()}`;
  const user = await (
    await page.request.post("/api/users", {
      data: { username, password: "reader-browser-password" },
    })
  ).json();
  const project = (await snapshot(page, url)).worktree.project;
  expect(
    (
      await page.request.put(`/api/projects/${project}/members/${user.id}`, {
        data: { role: "reader" },
      })
    ).ok(),
  ).toBeTruthy();
  const context = await browser.newContext({ baseURL });
  try {
    const reader = await context.newPage();
    await reader.goto("/");
    await reader.getByLabel("Username", { exact: true }).fill(username);
    await reader
      .getByLabel("Password", { exact: true })
      .fill("reader-browser-password");
    await reader.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      reader.getByRole("navigation", { name: "Workspace", exact: true }),
    ).toBeVisible();
    await reader.goto(`/worktrees/${id}/variables?variable=revenue_status`);
    const readOnly = reader.getByRole("complementary", {
      name: "revenue_status",
    });
    await expect(
      readOnly.getByLabel("Default value", { exact: true }),
    ).toBeDisabled();
    await expect(
      readOnly.getByRole("button", { name: "Save changes" }),
    ).toHaveCount(0);
    await expect(
      reader.getByRole("button", { name: "New variable" }),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("merge conflicts on variables are resolved per variable", async ({
  page,
}) => {
  const { url } = await example(page, bindOrderStatus());
  const branch = await (
    await page.request.post(`${url}/branches`, {
      data: { name: "feature/status" },
    })
  ).json();
  await update(page, url, (bundle) => {
    (bundle.variables as Record<string, any>).order_status.environments = {
      prod: "pending",
    };
  });
  await update(page, `/api/worktrees/${branch.id}`, (bundle) => {
    const variable = (bundle.variables as Record<string, any>).order_status;
    variable.environments = { prod: "refunded" };
    variable.description = "Statuses counted as revenue.";
  });
  await page.goto(url.replace("/api", "") + "/flow");
  await page
    .getByRole("button", { name: "Git synchronization", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Project Git workspace" });
  await dialog
    .getByRole("button", { name: "Branches", exact: true })
    .first()
    .click();
  await dialog
    .getByLabel("Source branch")
    .selectOption("refs/heads/feature/status");
  await dialog
    .getByRole("button", { name: "Review merge", exact: true })
    .click();
  // Only the production value conflicts; the description merges cleanly.
  const conflict = dialog.locator(".git-conflict");
  await expect(conflict).toHaveCount(1);
  await expect(conflict.locator("legend")).toContainText(
    "Variable order_status · prod value",
  );
  await expect(conflict.locator(".git-conflict-values")).toContainText(
    "pending",
  );
  await expect(conflict.locator(".git-conflict-values")).toContainText(
    "refunded",
  );
  await conflict.getByLabel("Incoming", { exact: false }).check();
  await dialog.getByRole("button", { name: "Apply reviewed merge" }).click();
  await expect(dialog).toContainText("Branch merged");
  expect((await snapshot(page, url)).bundle!.variables).toMatchObject({
    order_status: {
      description: "Statuses counted as revenue.",
      environments: { prod: "refunded" },
    },
  });
});

test("promoting a choice preserves spaces in its options and the current result", async ({
  page,
}) => {
  const { id, url } = await example(page, (bundle) => {
    bundle.templates.spaced = `-- @label Spaced choices
-- @kind source
-- @param status: choice(paid in full|refunded) = "paid in full"
-- @output result
SELECT {{ status }} AS status;`;
    bundle.flow.nodes = [
      {
        id: "spaced",
        template: "spaced",
        params: {},
        position: { x: 0, y: 0 },
      },
    ];
    bundle.flow.edges = [];
  });
  await run(page, url, "dev");
  await page.goto(`/worktrees/${id}/flow`);
  await page.locator('.react-flow__node[data-id="spaced"]').click();
  await page
    .getByRole("button", { name: "Bind status to a variable", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Create a variable from “paid in full”…",
      exact: true,
    })
    .click();
  const dialog = page.getByRole("dialog", { name: "New variable" });
  await expect(dialog.getByLabel("Default value", { exact: true })).toHaveValue(
    "paid in full",
  );
  await dialog
    .getByRole("button", { name: "Create and bind", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  expect((await snapshot(page, url)).bundle!.variables).toMatchObject({
    status: { type: "choice(paid in full|refunded)", default: "paid in full" },
  });
  expect(await resultStatus(page, url, "dev", "spaced")).toBe("valid");
});

test("invalid numeric variable drafts cannot save an older value", async ({
  page,
}) => {
  const { id, url } = await example(page, (bundle) => {
    bundle.variables = { threshold: { type: "number", default: 300 } };
  });
  await page.goto(`/worktrees/${id}/variables?variable=threshold`);
  const editor = page.getByRole("complementary", { name: "threshold" });
  await editor
    .getByLabel("Description", { exact: true })
    .fill("Minimum amount");
  const value = editor.getByLabel("Default value", { exact: true });
  await value.fill("-");
  await value.blur();
  const save = editor.getByRole("button", {
    name: "Save changes",
    exact: true,
  });
  await expect(save).toBeDisabled();
  await value.fill("1e-3");
  await value.blur();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  expect((await snapshot(page, url)).bundle!.variables).toMatchObject({
    threshold: { default: 0.001, description: "Minimum amount" },
  });
});

test("a variable named constructor can be created, bound and audited", async ({
  page,
}) => {
  const { id, url } = await example(page);
  await page.goto(`/worktrees/${id}/variables`);
  await page.getByRole("button", { name: "New variable", exact: true }).click();
  const editor = page.getByRole("complementary", { name: "New variable" });
  await editor.getByLabel("Name", { exact: true }).fill("constructor");
  await editor.getByLabel("Default value", { exact: true }).fill("paid");
  await editor.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "constructor" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Flow", exact: true }).click();
  await node(page, "Paid orders").click();
  const inspector = page.locator(".inspector");
  await inspector
    .getByRole("button", { name: "Bind status to a variable", exact: true })
    .click();
  await inspector.getByRole("button", { name: /^constructor/ }).click();
  await expect(
    inspector.getByRole("group", { name: "status is bound to constructor" }),
  ).toBeVisible();
  // The run reads the saved bundle: start it once the binding is saved.
  await saved(page);
  expect(
    (await snapshot(page, url)).bundle!.flow.nodes.find(
      (n) => n.id === "validated",
    )!.params.status,
  ).toEqual({ $var: "constructor" });
  await run(page, url, "dev");
  await inspector.getByRole("button", { name: "SQL", exact: true }).click();
  await expect(inspector.locator(".variable-values")).toContainText(
    "constructor",
  );
  await page.getByRole("link", { name: "History", exact: true }).click();
  await page.locator(".history-row").first().click();
  await expect(
    page
      .getByRole("dialog", { name: "View execution" })
      .locator(".run-variables"),
  ).toContainText("constructor");
});

test("the editor normalizes imported types and rejects invalid choice declarations", async ({
  page,
}) => {
  const { id, url } = await example(page, (bundle) => {
    bundle.variables = {
      cities: { type: " list < text > ", default: ["New York"] },
    };
  });
  await page.goto(`/worktrees/${id}/variables?variable=cities`);
  const editor = page.getByRole("complementary", { name: "cities" });
  await expect(editor.getByLabel("Type", { exact: true })).toHaveValue(
    "list<text>",
  );
  await editor
    .getByLabel("Description", { exact: true })
    .fill("Selected cities");
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    editor.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  expect((await snapshot(page, url)).bundle!.variables).toMatchObject({
    cities: { type: "list<text>", default: ["New York"] },
  });
  await page.getByRole("button", { name: "New variable", exact: true }).click();
  const creation = page.getByRole("complementary", { name: "New variable" });
  await creation.getByLabel("Name", { exact: true }).fill("status");
  await creation.getByLabel("Type", { exact: true }).selectOption("choice");
  const options = creation.getByLabel("Options, separated by commas", {
    exact: true,
  });
  await options.fill("paid, paid");
  await creation
    .getByLabel("Default value", { exact: true })
    .selectOption("paid");
  const create = creation.getByRole("button", { name: "Create", exact: true });
  await expect(create).toBeDisabled();
  await options.fill("paid, refunded (partial)");
  await expect(create).toBeDisabled();
  await options.fill("paid, refunded");
  await create.click();
  await expect(
    page.getByRole("complementary", { name: "status" }),
  ).toBeVisible();
  expect((await snapshot(page, url)).variables!.file_error).toBeNull();
});

test("filter on a period with a variable, typed or chosen in the guided form (workflow 4)", async ({
  page,
}) => {
  const { id, url } = await example(page, (bundle) => {
    bundle.variables = {
      report_start: {
        type: "date",
        description: "First order date included in the reports.",
        default: "2026-10-15",
        environments: { prod: "2026-10-01" },
      },
      oracle_schema: { type: "identifier", default: "DEMO" },
    };
    bundle.flow.nodes.push({
      id: "recent",
      template: "filter",
      label: "Recent orders",
      params: { condition: "amount >= 0" },
      position: { x: 280, y: 420 },
    });
    bundle.flow.edges.push({
      id: "orders_result_recent_source",
      source: "orders",
      target: "recent",
      sourceHandle: "result",
      targetHandle: "source",
    });
  });
  await run(page, url, "dev");
  await page.goto(`/worktrees/${id}/flow?environment=dev`);
  await node(page, "Recent orders").click();
  const inspector = page.locator(".inspector");
  const condition = inspector.getByRole("textbox", { name: /condition/ });
  await condition.fill("order_date >= ");
  await condition.pressSequentially("{{ var.");
  // Only variables an expression can bind are suggested, with their value.
  const suggestions = inspector.getByRole("listbox", { name: "Variables" });
  await expect(suggestions.getByRole("option")).toHaveCount(1);
  await expect(
    suggestions.getByRole("option", { name: /report_start/ }),
  ).toContainText("date · dev 2026-10-15");
  await condition.press("Enter");
  await expect(condition).toHaveValue("order_date >= {{ var.report_start }}");
  await expect(suggestions).toBeHidden();
  const values = inspector.getByRole("list", {
    name: "Variables used by this expression",
  });
  await expect(values).toContainText("report_start");
  await expect(values.locator(".active")).toHaveText(
    "dev 2026-10-15 (default)",
  );
  await expect(values).toContainText("prod 2026-10-01");
  await inspector
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await saved(page);
  const recent = (await snapshot(page, url)).bundle!.flow.nodes.find(
    (n) => n.id === "recent",
  )!;
  expect(recent.params.condition).toBe("order_date >= {{ var.report_start }}");
  expect(
    (await snapshot(page, url)).variables!.declarations.report_start.usages,
  ).toEqual([
    {
      node: "recent",
      label: "Recent orders",
      param: "condition",
      expression: true,
    },
  ]);

  // Each environment binds its own date.
  await run(page, url, "dev");
  await run(page, url, "prod");
  const rows = async (environment: string) =>
    (
      await (
        await page.request.get(
          `${url}/preview/recent?environment=${environment}&limit=200`,
        )
      ).json()
    ).filtered_count as number;
  expect(await rows("dev")).toBe(50);
  expect(await rows("prod")).toBe(120);

  await inspector.getByRole("button", { name: "SQL", exact: true }).click();
  const bound = inspector.locator(".variable-values");
  await expect(bound).toContainText("report_start");
  await expect(bound).toContainText("condition · $var_report_start");
  await expect(bound).toContainText("2026-10-15");

  // Lineage shows the date that was used, labeled with its variable.
  await page
    .getByRole("button", { name: /Explain this value: amount, rows 1,/ })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(page.locator(".lineage-loading")).toHaveCount(0);
  await dialog
    .getByRole("button", { name: /Source and selection details/ })
    .first()
    .click();
  await expect(dialog.locator(".lineage-details")).toContainText(
    "order_date >= CAST('2026-10-15' AS DATE) (report_start)",
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // The guided form offers the same variables as a filter value.
  await inspector
    .getByRole("button", { name: "Parameters", exact: true })
    .click();
  await inspector
    .getByLabel("Column", { exact: true })
    .selectOption("order_date");
  await inspector.getByLabel("Operator", { exact: true }).selectOption("<");
  await inspector
    .getByLabel("Value source", { exact: true })
    .selectOption("report_start");
  await expect(inspector.getByLabel("Value", { exact: true })).toBeHidden();
  await inspector
    .getByRole("button", { name: "Apply to parameters", exact: true })
    .click();
  await expect(condition).toHaveValue('"order_date" < {{ var.report_start }}');
  await saved(page);
  await expect
    .poll(
      async () =>
        (await snapshot(page, url)).bundle!.flow.nodes.find(
          (n) => n.id === "recent",
        )!.params.condition,
    )
    .toBe('"order_date" < {{ var.report_start }}');
  await expect(page.locator(".preview-header .badge")).toHaveText("Stale");
});
