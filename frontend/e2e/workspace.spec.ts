import fr from "../src/locales/fr.json" with { type: "json" };
import { test, expect, type Page } from "@playwright/test";

async function signIn(page: Page) {
  await page.goto("/");
  await page
    .getByLabel("Password", { exact: true })
    .fill("duckpad-browser-test");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Workspace", exact: true }),
  ).toBeVisible();
}
async function sample(page: Page) {
  await signIn(page);
  const workspace = await (await page.request.get("/api/workspace")).json();
  if (workspace.projects.length) {
    const result = await (
      await page.request.post("/api/example", { data: {} })
    ).json();
    await page.evaluate(
      (id) => localStorage.setItem("duckpad-worktree", id),
      result.id,
    );
    await page.reload();
  } else
    await page.getByRole("button", { name: "Open example project" }).click();
  await expect(
    page.getByRole("button", { name: "Run pipeline", exact: true }),
  ).toBeVisible();
}
async function run(page: Page) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/runs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Run pipeline", exact: true }).click();
  const result = await (await response).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/runs/" + result.id)).json())
          .status,
    )
    .toBe("success");
  await expect(
    page.getByRole("button", { name: "Run pipeline", exact: true }),
  ).toBeVisible();
}

test("complete example, ordered outputs, nested components, lineage pagination and native export", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await sample(page);
  await run(page);
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Regional revenue", { exact: true }) })
    .click();
  await page.getByLabel("Output", { exact: true }).selectOption("report");
  await expect(
    page.getByRole("button", { name: /Explain this value: revenue, rows 1,/ }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: /Explain this value: revenue, rows 1,/ })
    .click();
  await expect(
    page.getByText("Complete explanation", { exact: true }),
  ).toBeVisible();
  await page.locator(".lineage-panel .contribution").first().click();
  await expect(page.locator(".lineage-panel")).toContainText(
    "27 contributions",
    { ignoreCase: true },
  );
  await expect(
    page.locator(".lineage-panel .contribution").first(),
  ).toContainText("amount");
  await page
    .locator(".lineage-panel")
    .getByRole("button", { name: "Next", exact: true })
    .click();
  await expect(page.locator(".lineage-panel .pager")).toContainText("10 / 27");
  await page
    .locator(".lineage-panel")
    .getByTitle("Close", { exact: true })
    .click();
  await page
    .locator(".inspector")
    .getByRole("button", { name: "Open component", exact: true })
    .click();
  await expect(
    page.getByText(
      "You are editing a shared component definition in this branch.",
    ),
  ).toBeVisible();
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Regional summary", { exact: true }) })
    .dblclick();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await run(page);
  expect(errors).toEqual([]);
});

test("theme and language persist without a project commit and environments have isolated results", async ({
  page,
}) => {
  await sample(page);
  await run(page);
  const worktree = await page.evaluate(() =>
    localStorage.getItem("duckpad-worktree"),
  );
  const before = await (
    await page.request.get("/api/worktrees/" + worktree)
  ).json();
  await page.getByTitle("Language", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: fr.run, exact: true }),
  ).toBeVisible();
  await page.getByTitle(fr.dark, { exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("lang", "fr");
  const after = await (
    await page.request.get("/api/worktrees/" + worktree)
  ).json();
  expect(after.commit).toBe(before.commit);
  await page.getByLabel(fr.environment, { exact: true }).selectOption("prod");
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Orders", { exact: true }) })
    .click();
  await expect(page.getByText(fr.noResult, { exact: true })).toBeVisible();
  await page.getByTitle(fr.language, { exact: true }).click();
  await page.getByTitle("Light", { exact: true }).click();
  await run(page);
  await expect(page.locator(".data-table tbody tr")).toHaveCount(100);
});

test("parameter change marks retained previews stale until a manual rerun", async ({
  page,
}) => {
  await sample(page);
  await run(page);
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Paid orders", { exact: true }) })
    .click();
  await page.getByLabel("Output", { exact: true }).selectOption("orders");
  const status = page
    .locator(".inspector")
    .getByRole("textbox", { name: /status/ });
  await status.fill("refunded");
  await status.blur();
  await expect(page.locator(".preview-header .badge")).toHaveText("Stale");
  await expect(page.locator(".data-table .cell").first()).toBeDisabled();
  await run(page);
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  await expect(page.locator(".preview-header")).toContainText("13 rows");
});

test("Git branch creation, isolated edits and explicit merge", async ({
  page,
}) => {
  await sample(page);
  await page.getByTitle("New working branch", { exact: true }).click();
  await page
    .getByLabel("Branch name", { exact: true })
    .fill("test/browser-branch-" + Date.now());
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Compare & merge", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Documentation", exact: true })
    .first()
    .click();
  await page
    .locator(".project-documentation")
    .fill("A branch-specific business definition.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await page
    .getByRole("button", { name: "Compare & merge", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(page.getByLabel("Branch", { exact: true })).toContainText(
    "main",
  );
  await page.getByRole("button", { name: "History", exact: true }).click();
  await page.getByRole("button", { name: "Git history", exact: true }).click();
  await expect(page.locator(".history-row").first()).toContainText(
    "merge test/browser-branch",
  );
});

test("drag a filter, configure it without SQL, and group it into a reusable component", async ({
  page,
}) => {
  await sample(page);
  await run(page);
  await page
    .locator(".palette-item")
    .filter({ has: page.getByText("Filter", { exact: true }) })
    .dragTo(page.locator(".react-flow__pane"), {
      targetPosition: { x: 350, y: 240 },
    });
  await expect(page.locator(".react-flow__node")).toHaveCount(10);
  const inspector = page.locator(".inspector");
  await inspector
    .getByLabel("source", { exact: true })
    .selectOption({ label: "Orders · result" });
  await expect(inspector.getByLabel("Column", { exact: true })).toContainText(
    "amount",
  );
  await inspector.getByLabel("Column", { exact: true }).selectOption("amount");
  await inspector.getByLabel("Operator", { exact: true }).selectOption(">");
  await inspector.getByLabel("Value", { exact: true }).fill("100");
  await inspector
    .getByRole("button", { name: "Apply to parameters", exact: true })
    .click();
  await inspector
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await run(page);
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  await expect(
    inspector.getByRole("textbox", { name: /condition/ }),
  ).toHaveValue('"amount" > 100');
  await page.locator(".group-button").click();
  await page
    .getByRole("dialog")
    .getByLabel("Component name")
    .fill("Large orders");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Create", exact: true })
    .click();
  await expect(
    page
      .locator(".react-flow__node")
      .filter({ has: page.getByText("Large orders", { exact: true }) }),
  ).toBeVisible();
  await inspector
    .getByRole("button", { name: "Open component", exact: true })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await run(page);
});

test("conflicting parameter edits survive reload and can be resolved explicitly", async ({
  page,
}) => {
  await sample(page);
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Paid orders", { exact: true }) })
    .click();
  const status = page
    .locator(".inspector")
    .getByRole("textbox", { name: /status/ });
  await status.fill("refunded");
  const worktree = await page.evaluate(() =>
    localStorage.getItem("duckpad-worktree"),
  );
  const snapshot = await (
    await page.request.get("/api/worktrees/" + worktree)
  ).json();
  snapshot.bundle.flow.nodes.find(
    (n: any) => n.label === "Paid orders",
  ).params.status = "pending";
  expect(
    (
      await page.request.put("/api/worktrees/" + worktree, {
        data: { revision: snapshot.revision, bundle: snapshot.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await status.blur();
  await expect(
    page.getByRole("button", { name: "Save resolution", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "Save resolution", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("refunded");
  await expect(page.getByRole("dialog")).toContainText("pending");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Use my proposal", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save resolution", exact: true }),
  ).toHaveCount(0);
  await run(page);
});

test("an open lineage explanation is interrupted when its generation is recalculated", async ({
  page,
}) => {
  await sample(page);
  await run(page);
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Regional revenue", { exact: true }) })
    .click();
  await page.getByLabel("Output", { exact: true }).selectOption("report");
  await page
    .getByRole("button", { name: /Explain this value: revenue, rows 1,/ })
    .click();
  await expect(
    page.getByText("Complete explanation", { exact: true }),
  ).toBeVisible();
  await run(page);
  await expect(page.locator(".lineage-panel")).toContainText(
    "This exploration was interrupted",
  );
  await expect(page.locator(".lineage-panel .contribution")).toHaveCount(0);
});

test("connection capabilities constrain source and export forms without a project commit", async ({
  page,
}) => {
  await sample(page);
  const worktree = await page.evaluate(() =>
    localStorage.getItem("duckpad-worktree"),
  );
  const before = await (
    await page.request.get("/api/worktrees/" + worktree)
  ).json();
  await page.request.put("/api/catalog/connector", {
    data: {
      id: "read_only",
      name: "Read only files",
      parameters: [{ name: "root", type: "text", default: "" }],
      capabilities: ["read"],
      init_sql: "",
    },
  });
  await page.request.put("/api/catalog/connection", {
    data: {
      id: "read_only_files",
      name: "Read only files",
      connector: "read_only",
      environments: { dev: { root: "" }, prod: { root: "" } },
    },
  });
  await page.reload();
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Orders", { exact: true }) })
    .click();
  await expect(
    page.locator(".inspector").getByRole("combobox", { name: /connection/ }),
  ).toContainText("Read only files");
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Export revenue", { exact: true }) })
    .click();
  await expect(
    page.locator(".inspector").getByRole("combobox", { name: /connection/ }),
  ).not.toContainText("Read only files");
  const after = await (
    await page.request.get("/api/worktrees/" + worktree)
  ).json();
  expect(after.commit).toBe(before.commit);
});
