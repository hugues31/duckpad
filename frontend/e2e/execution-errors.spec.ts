import { expect, test } from "@playwright/test";
import {
  autosaved,
  closeCode,
  closeEditor,
  codePanel,
  codeSaved,
  signIn,
} from "./helpers";
import type { Run, Snapshot } from "../src/types";

test("muting enrichment explains blocked components and downstream nodes directly", async ({
  page,
}) => {
  test.setTimeout(120000);
  await signIn(page);
  const created = await page.request.post("/api/example", { data: {} });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  await page.goto(`/worktrees/${id}/flow`);
  const node = (key: string) =>
    page.locator(`.react-flow__node[data-id="${key}"]`);
  const results = page.getByRole("region", { name: "Results", exact: true });
  const run = async (expected: string) => {
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/worktrees/${id}/runs`) &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Run all", exact: true }).click();
    const started = await (await response).json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/runs/${started.id}`)).json())
            .status,
        { timeout: 90000 },
      )
      .toBe(expected);
    await expect(page.locator(".run-failure-notice")).toHaveCount(0);
  };
  const toggle = async () => {
    await node("enriched").locator(".node-shape").click();
    await autosaved(page, () => page.keyboard.press("m"));
  };
  await toggle();
  await run("partial_failure");
  // The default output succeeds; another nested node fails and blocks the report.
  await node("report").locator(".node-shape").click();
  const error = results.getByRole("alert", {
    name: "Blocked by Regional revenue / Regional summary / Revenue by region",
    exact: true,
  });
  await expect(error).toHaveCount(1);
  await expect(error).toContainText('Referenced column "region" not found');
  await page
    .locator(".inspector .result-summary")
    .getByRole("button", { name: "Last run failed", exact: true })
    .click();
  await expect(results.getByRole("tab", { name: /^Log/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // The log is the failed node's, and the card above it tells the error once.
  await expect(error).toBeVisible();
  await expect(results.locator(".log-error")).toHaveCount(0);
  await expect(results.locator(".run-summary .badge")).toHaveText("Failed");
  await expect(error.getByRole("button", { name: "View log" })).toHaveCount(0);
  await error.getByRole("button", { name: /Open code at line/ }).click();
  const editor = page.getByRole("dialog");
  await expect(editor.locator(".squiggly-error")).not.toHaveCount(0);
  await closeEditor(editor);
  // The export has no rows and is several dependencies away from the original failure.
  await node("export").locator(".node-shape").click();
  await expect(error).toContainText('Referenced column "region" not found');
  await toggle();
  await run("success");
  await node("report").locator(".node-shape").click();
  await expect(results.getByRole("alert")).toHaveCount(0);
  // A later failure also stays visible when successful rows have been retained.
  await toggle();
  await run("partial_failure");
  await node("report").locator(".node-shape").click();
  await expect(error).toContainText('Referenced column "region" not found');
  await page.getByLabel("Output", { exact: true }).selectOption("report");
  await results.getByRole("tab", { name: "Data", exact: true }).click();
  await expect(results.locator(".data-table")).toBeVisible();
  await expect(error).toBeVisible();
});

test("a missing extension shows the run failure on Flow with settings and history actions", async ({
  page,
}) => {
  await signIn(page);
  const created = await page.request.post("/api/projects", {
    data: { name: "Run preparation failure" },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  const endpoint = `/api/worktrees/${id}`;
  const snapshot: Snapshot = await (await page.request.get(endpoint)).json();
  const bundle = snapshot.bundle!;
  bundle.flow.nodes = [
    { id: "query", name: "Rows", position: { x: 0, y: 0 }, params: {} },
  ];
  bundle.node_sql = {
    "nodes/query.sql": "-- @output result\nSELECT 1 AS amount;",
  };
  // This requires an administrator import, even though the SQL does not use Delta.
  bundle.extensions = { delta: { source: "core", enabled: true } };
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/worktrees/${id}/flow?environment=dev`);
  const launch = async () => {
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith(`${endpoint}/runs`) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Run all", exact: true }).click();
    return (await response).json();
  };
  const run = await launch();
  const notice = page.locator(".run-failure-notice");
  // No node selection or history navigation is needed to discover the failure.
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Cannot initialize execution worker");
  await expect(notice).toContainText("Import delta from core");
  const outcome: Run = await (
    await page.request.get(`/api/runs/${run.id}`)
  ).json();
  expect(outcome.status).toBe("failed");
  expect(outcome.nodes).toEqual({});
  await expect(
    notice.getByRole("link", { name: "Execution history" }),
  ).toHaveAttribute(
    "href",
    `/worktrees/${id}/history?environment=dev&run=${run.id}`,
  );
  await page.getByLabel("Environment", { exact: true }).selectOption("prod");
  await expect(notice).toHaveCount(0);
  await page.getByLabel("Environment", { exact: true }).selectOption("dev");
  await expect(notice).toContainText("Import delta from core");
  await notice.getByRole("link", { name: "Execution history" }).click();
  await expect(page.getByRole("dialog")).toContainText(outcome.error!);
  await page.goBack();
  await notice.getByRole("link", { name: "Open extension settings" }).click();
  await expect(
    page.getByRole("heading", { name: "Extensions for this project" }),
  ).toBeVisible();
  const updated: Snapshot = await (await page.request.get(endpoint)).json();
  updated.bundle!.extensions = {};
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: updated.revision, bundle: updated.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goBack();
  const retry = await launch();
  await expect(notice).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${retry.id}`)).json()).status,
    )
    .toBe("success");
  await expect(notice).toHaveCount(0);
});

test("execution errors open from the canvas, point into saved code and clear after a successful run", async ({
  page,
}) => {
  test.setTimeout(90000);
  await signIn(page);
  const created = await page.request.post("/api/projects", {
    data: { name: "Execution errors" },
  });
  const { id } = await created.json();
  const endpoint = `/api/worktrees/${id}`;
  const snapshot: Snapshot = await (await page.request.get(endpoint)).json();
  const code =
    "-- @input source\n-- @output result\nSELECT countryy, COUNT(*) AS customers FROM {{ source }} GROUP BY ALL;";
  const uploaded = await page.request.post(`${endpoint}/uploads`, {
    multipart: {
      file: {
        name: "customers.csv",
        mimeType: "text/csv",
        buffer: Buffer.from("country,customer_id\nFrance,1\n"),
      },
    },
  });
  expect(uploaded.ok()).toBeTruthy();
  const file = (await uploaded.json()).path as string;
  const bundle = snapshot.bundle!;
  bundle.flow.nodes = [
    { id: "source", name: "Customers", position: { x: 0, y: 0 }, params: {} },
    {
      id: "query",
      name: "Customer counts",
      position: { x: 250, y: 0 },
      params: {},
    },
  ];
  bundle.flow.nodes[0].params = { file };
  bundle.flow.edges = [
    {
      id: "edge",
      source: "source",
      sourceHandle: "result",
      target: "query",
      targetHandle: "source",
    },
  ];
  bundle.node_sql = {
    "nodes/source.sql":
      "-- @param file: file\n-- @output result\nSELECT * FROM read_csv({{ file }});",
    "nodes/query.sql": code,
  };
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/worktrees/${id}/flow?node=query`);
  const panel = page.getByRole("region", { name: "Results", exact: true });
  await expect(panel).toContainText("Ready when you are");
  const run = async () => {
    const launched = await (
      await page.request.post(`${endpoint}/runs`, {
        data: { environment: "dev", node: "query" },
      })
    ).json();
    await expect
      .poll(
        async () =>
          (
            (await (
              await page.request.get(`/api/runs/${launched.id}`)
            ).json()) as Run
          ).status,
      )
      .toMatch(/success|partial_failure|failed/);
  };
  await run();
  await page.reload();
  await panel
    .getByLabel("Output", { exact: true })
    .selectOption("input:source");
  await expect(panel.locator(".data-table")).toContainText("France");
  await panel.getByRole("tab", { name: "Log", exact: true }).click();
  await page
    .locator('[data-id="query"]')
    .getByRole("button", { name: "Failed", exact: true })
    .click();
  await expect(
    panel.getByRole("tab", { name: "Data", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const card = panel.getByRole("alert", { name: "Last run failed" });
  await expect(card).toContainText("countryy");
  await expect(card).toContainText("Candidate bindings");
  await expect(card.locator(".execution-error-message")).not.toContainText(
    /data_|DESCRIBE/,
  );
  await expect(
    card.getByRole("button", { name: "Ask the assistant" }),
  ).toHaveCount(0);
  await card.getByText("Executed SQL", { exact: true }).click();
  await expect(card.locator("details pre")).toContainText("DESCRIBE SELECT");
  await card.getByRole("button", { name: "View log" }).click();
  await expect(
    panel.getByRole("tab", { name: "Log", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await panel.getByRole("tab", { name: "Data", exact: true }).click();
  await card.getByRole("button", { name: "Open code at line 3" }).click();
  // The code docks beside the canvas, with the results still in view.
  const dialog = codePanel(page);
  const editor = dialog.locator(".monaco-editor textarea");
  await expect(dialog.locator(".squiggly-error")).not.toHaveCount(0);
  await expect(editor).toBeFocused();
  // The navigation action places the caret on the reported SQL line.
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.keyboard.press("ControlOrMeta+C");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "SELECT countryy",
  );
  await page.keyboard.press("ControlOrMeta+A");
  await page.evaluate(
    (text) => navigator.clipboard.writeText(text),
    code.replace("countryy", "country"),
  );
  await codeSaved(page, () => page.keyboard.press("ControlOrMeta+V"));
  await expect(dialog.locator(".squiggly-error")).toHaveCount(0);
  await closeCode(page);
  await expect(card).toContainText("The code has changed since this failure");
  await run();
  await page.reload();
  await expect(card).toHaveCount(0);
  await expect(panel.locator(".data-table")).toContainText("France");
});

test("missing functions link editors to extension setup in Project settings", async ({
  page,
}) => {
  await signIn(page);
  const tree = await (
    await page.request.post("/api/projects", {
      data: { name: "Missing function" },
    })
  ).json();
  const endpoint = `/api/worktrees/${tree.id}`;
  const snapshot: Snapshot = await (await page.request.get(endpoint)).json();
  snapshot.bundle!.flow.nodes = [
    {
      id: "query",
      label: "Extension function",
      params: {},
      position: { x: 0, y: 0 },
    },
  ];
  snapshot.bundle!.node_sql = {
    "nodes/query.sql":
      "-- @output result\nSELECT missing_extension_function();",
  };
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle: snapshot.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  const run = await (
    await page.request.post(`${endpoint}/runs`, {
      data: { environment: "dev", node: "query" },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
    )
    .toBe("failed");
  await page.goto(`/worktrees/${tree.id}/flow?node=query`);
  const error = page.getByRole("alert", { name: "Last run failed" });
  await expect(error).toContainText("If this function comes from an extension");
  await error
    .getByRole("link", { name: "Open extension settings", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/extensions/);
  await expect(
    page.getByRole("heading", { name: "Extensions for this project" }),
  ).toBeVisible();
});
