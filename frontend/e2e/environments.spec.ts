import { expect, test, type Page } from "@playwright/test";
import { openInstanceSettings, signIn } from "./helpers";

async function project(page: Page) {
  const result = await (
    await page.request.post("/api/projects", {
      data: { name: "Environment checks" },
    })
  ).json();
  await page.goto(`/worktrees/${result.id}/flow`);
  return result.id as string;
}

async function waitForRun(page: Page, id: string) {
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${id}`)).json()).status,
    )
    .toBe("success");
  await expect(
    page.getByRole("button", { name: "Run pipeline", exact: true }),
  ).toBeEnabled();
}

test("selects a surviving environment before requesting results when dev is absent", async ({
  page,
}) => {
  await signIn(page);
  const created = await (
    await page.request.post("/api/projects", {
      data: { name: "Explicit environment" },
    })
  ).json();
  const endpoint = `/api/worktrees/${created.id}`;
  const snapshot = await (await page.request.get(endpoint)).json();
  snapshot.bundle.templates.constant =
    "-- @kind source\n-- @output result\nSELECT 42 AS value;";
  snapshot.bundle.flow.nodes = [
    {
      id: "constant",
      template: "constant",
      params: {},
      position: { x: 0, y: 0 },
    },
    {
      id: "export",
      template: "export_csv",
      params: { destination: "values.csv" },
      position: { x: 300, y: 0 },
    },
  ];
  snapshot.bundle.flow.edges = [
    {
      id: "edge",
      source: "constant",
      sourceHandle: "result",
      target: "export",
      targetHandle: "source",
    },
  ];
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle: snapshot.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  // A per-page catalog response avoids changing the shared test instance's environments.
  // API tests cover actual deletion and all eight operations against the surviving catalog.
  let releaseCatalog!: () => void;
  const catalogReady = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  await page.route("**/api/workspace", async (route) => {
    const response = await route.fetch();
    const workspace = await response.json();
    workspace.catalog.environments = ["prod"];
    workspace.catalog.environment_details =
      workspace.catalog.environment_details.filter(
        (item: { id: string }) => item.id === "prod",
      );
    await catalogReady;
    await route.fulfill({ response, json: workspace });
  });
  const selected: string[] = [];
  const operations = new Set<string>();
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith(endpoint + "/")) return;
    const operation = url.pathname.slice(endpoint.length + 1).split("/")[0];
    if (
      ![
        "status",
        "compile",
        "preview",
        "exports",
        "generations",
        "runs",
        "lineage",
      ].includes(operation)
    )
      return;
    selected.push(
      request.method() === "POST"
        ? request.postDataJSON().environment
        : url.searchParams.get("environment")!,
    );
    operations.add(operation);
  });
  try {
    await page.goto(`/worktrees/${created.id}/flow?environment=dev`);
    await expect(
      page.getByRole("status", { name: "Loading…", exact: true }),
    ).toBeVisible();
    expect(selected).toEqual([]);
    releaseCatalog();
    await expect(page.getByLabel("Environment", { exact: true })).toHaveValue(
      "prod",
    );
    await expect(page).toHaveURL(/environment=prod/);
    const launched = page.waitForResponse(
      (response) =>
        response.url().endsWith("/runs") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "Confirm execution" })
      .getByRole("button", { name: "Confirm and run", exact: true })
      .click();
    await waitForRun(page, (await (await launched).json()).id);
    await page.locator('.react-flow__node[data-id="constant"]').click();
    await page
      .getByRole("button", { name: /Explain this value: value, rows 1,/ })
      .click();
    await expect(page.locator(".lineage-card.root")).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page
      .locator(".inspector")
      .getByRole("button", { name: "SQL", exact: true })
      .click();
    await expect.poll(() => operations.has("compile")).toBeTruthy();
    await page.locator('.react-flow__node[data-id="export"]').click();
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download exported data", exact: true })
      .click();
    expect((await download).suggestedFilename()).toBe("values.csv");
    expect([...operations].sort()).toEqual([
      "compile",
      "exports",
      "generations",
      "lineage",
      "preview",
      "runs",
      "status",
    ]);
    expect(selected.length).toBeGreaterThan(7);
    expect(new Set(selected)).toEqual(new Set(["prod"]));
  } finally {
    releaseCatalog();
    await page.request.delete(`/api/projects/${created.project}`);
  }
});

test("manage environment labels, colors, confirmation and selected-environment deletion", async ({
  page,
}) => {
  await signIn(page);
  const worktree = await project(page);
  const before = await (
    await page.request.get(`/api/worktrees/${worktree}`)
  ).json();
  try {
    await openInstanceSettings(page, "Environments");
    await expect(
      page.getByRole("article", { name: "dev", exact: true }),
    ).toContainText("Run without confirmation");
    await expect(
      page.getByRole("article", { name: "prod", exact: true }),
    ).toContainText("Confirm every run");
    await page
      .getByRole("button", { name: "Add environment", exact: true })
      .click();
    await page.getByLabel("ID", { exact: true }).fill("qa_ui");
    await page.getByLabel("Label", { exact: true }).fill("Quality assurance");
    await page.getByLabel("Color", { exact: true }).fill("#7c3aed");
    await page.getByLabel("Confirm every run", { exact: true }).check();
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Edit · Quality assurance", exact: true })
      .click();
    await expect(page.getByLabel("ID", { exact: true })).toBeDisabled();
    await page.getByLabel("Label", { exact: true }).fill("Release candidate");
    await page.getByLabel("Color", { exact: true }).fill("#123abc");
    await page
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.reload();
    await openInstanceSettings(page, "Environments");
    const card = page.getByRole("article", {
      name: "Release candidate",
      exact: true,
    });
    await expect(card.locator(".env-dot")).toHaveCSS(
      "background-color",
      "rgb(18, 58, 188)",
    );
    await expect(card).toContainText("Confirm every run");
    await page.setViewportSize({ width: 800, height: 900 });
    await page.screenshot({
      path: "test-results/environments.png",
      fullPage: true,
    });
    await openInstanceSettings(page, "Connections");
    await page
      .getByRole("button", { name: "New connection", exact: true })
      .click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Release candidate", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.goto(`/worktrees/${worktree}/flow`);
    await page.getByLabel("Environment", { exact: true }).selectOption("qa_ui");
    await expect(page.locator(".environment-picker .select-value")).toHaveText(
      "Release candidate",
    );
    await expect(page.locator(".environment-picker .env-dot")).toHaveCSS(
      "background-color",
      "rgb(18, 58, 188)",
    );
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    await expect(
      page.getByRole("dialog", { name: "Confirm execution" }),
    ).toContainText("Release candidate");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await openInstanceSettings(page, "Environments");
    await page
      .getByRole("button", { name: "Delete · Release candidate", exact: true })
      .click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(card).toBeVisible();
    await page
      .getByRole("button", { name: "Delete · Release candidate", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(card).toHaveCount(0);
    await page.getByRole("link", { name: "Pipelines", exact: true }).click();
    await expect(page.getByLabel("Environment", { exact: true })).toHaveValue(
      "dev",
    );
    expect(
      (await (await page.request.get(`/api/worktrees/${worktree}`)).json())
        .commit,
    ).toBe(before.commit);
  } finally {
    await page.request.delete("/api/environments/qa_ui");
  }
});

test("confirmation gates every pipeline and node run, including stale clients", async ({
  page,
}) => {
  await signIn(page);
  const worktree = await project(page);
  const snapshot = await (
    await page.request.get(`/api/worktrees/${worktree}`)
  ).json();
  const bundle = snapshot.bundle;
  bundle.templates.constant =
    "-- @label Constant\n-- @output result\nSELECT 1 AS value;\n";
  bundle.flow.nodes = [
    {
      id: "constant",
      template: "constant",
      label: "Constant",
      params: {},
      position: { x: 100, y: 100 },
    },
  ];
  expect(
    (
      await page.request.put(`/api/worktrees/${worktree}`, {
        data: { revision: snapshot.revision, bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await page.reload();
  const original = (await (await page.request.get("/api/workspace")).json())
    .catalog.environment_details;
  const requests: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/runs"))
      requests.push(request.postDataJSON());
  });
  try {
    let launched = page.waitForResponse(
      (response) =>
        response.url().endsWith("/runs") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    await waitForRun(page, (await (await launched).json()).id);
    expect(requests).toHaveLength(1);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByLabel("Environment", { exact: true }).selectOption("prod");
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Confirm execution",
      exact: true,
    });
    await expect(dialog).toContainText("prod");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect(requests).toHaveLength(1);
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(requests).toHaveLength(1);
    for (let index = 0; index < 2; index++) {
      await page
        .getByRole("button", { name: "Run pipeline", exact: true })
        .click();
      await expect(dialog).toBeVisible();
      launched = page.waitForResponse(
        (response) =>
          response.url().endsWith("/runs") &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Confirm and run", exact: true })
        .click();
      await waitForRun(page, (await (await launched).json()).id);
      expect(requests).toHaveLength(index + 2);
    }
    await page
      .locator(".react-flow__node")
      .filter({ has: page.getByText("Constant", { exact: true }) })
      .click();
    await page.locator(".run-node").click();
    await expect(dialog).toContainText("constant");
    launched = page.waitForResponse(
      (response) =>
        response.url().endsWith("/runs") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Confirm and run", exact: true })
      .click();
    const result = await (await launched).json();
    await waitForRun(page, result.id);
    expect(requests.at(-1)).toMatchObject({
      environment: "prod",
      node: "constant",
      confirmed: true,
    });
    // The browser still has dev's original setting; the server must challenge it.
    await page.request.put("/api/environments/dev", {
      data: { ...original[0], confirm_before_run: true },
    });
    await page.getByLabel("Environment", { exact: true }).selectOption("dev");
    await page
      .getByRole("button", { name: "Run pipeline", exact: true })
      .click();
    await expect(dialog).toContainText("dev");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    const runs = await (
      await page.request.get(`/api/runs?worktree=${worktree}`)
    ).json();
    expect(runs).toHaveLength(4);
  } finally {
    await page.request.put("/api/environments/dev", { data: original[0] });
  }
});
