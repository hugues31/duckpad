import { expect, test } from "@playwright/test";
import { closeEditor, signIn } from "./helpers";
import type { Run, Snapshot } from "../src/types";

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
  const dialog = page.getByRole("dialog");
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
  await page.keyboard.press("ControlOrMeta+V");
  await expect(dialog.locator(".squiggly-error")).toHaveCount(0);
  await closeEditor(dialog);
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
