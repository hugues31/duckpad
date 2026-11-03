import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import type { Snapshot } from "../src/types";

test("display names follow SQL and templates through messages, lineage, usages and conflicts", async ({
  page,
}) => {
  test.setTimeout(90000);
  await signIn(page);
  const created = await page.request.post("/api/projects", {
    data: { name: "Readable nodes" },
  });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();
  const url = `/api/worktrees/${id}`;
  const read = async (): Promise<Snapshot> =>
    (await page.request.get(url)).json();
  const initial = await read();
  const bundle = initial.bundle!;
  bundle.flow.nodes = [
    { id: "node_report", params: {}, position: { x: 50, y: 100 } },
    {
      id: "node_filter",
      template: "filter",
      params: { condition: "amount > {{ var.minimum }}" },
      position: { x: 350, y: 100 },
    },
  ];
  bundle.node_sql = {
    "nodes/node_report.sql":
      "-- @label Revenue report\n-- @output result\nSELECT 42 AS amount;",
  };
  bundle.variables = { minimum: { type: "number", default: 0 } };
  expect(
    (
      await page.request.put(url, {
        data: { revision: initial.revision, bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/worktrees/${id}/flow`);
  await expect(page.locator(".node-title")).toHaveText([
    "Revenue report",
    "Filter",
  ]);
  await expect(page.locator(".banner.error")).toContainText(
    "flow.json: Connect input 'source' on Filter",
  );
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Filter", { exact: true }) })
    .click();
  await page
    .locator(".inspector")
    .getByRole("button", { name: "Run with ancestors", exact: true })
    .click();
  await expect(page.locator(".toast")).toContainText(
    "Connect input source on Filter",
  );

  const disconnected = await read();
  disconnected.bundle!.flow.edges = [
    {
      id: "edge",
      source: "node_report",
      sourceHandle: "result",
      target: "node_filter",
      targetHandle: "source",
    },
  ];
  expect(
    (
      await page.request.put(url, {
        data: { revision: disconnected.revision, bundle: disconnected.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  const history = await (await page.request.get(url + "/git/history")).json();
  expect(JSON.stringify(history.items)).toContain(
    "connect Revenue report → Filter",
  );

  const started = await page.request.post(url + "/runs", {
    data: { environment: "dev" },
  });
  expect(started.ok()).toBeTruthy();
  const run = await started.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
    )
    .toBe("success");
  await page.reload();
  await page
    .locator(".react-flow__node")
    .filter({ has: page.getByText("Filter", { exact: true }) })
    .click();
  await page
    .getByRole("button", { name: /Explain this value: amount, rows 1,/ })
    .click();
  const lineage = page.getByRole("dialog", {
    name: "How this value was calculated",
  });
  await expect(lineage.locator(".lineage-card.is-source")).toContainText(
    "Revenue report",
  );
  await expect(lineage).not.toContainText("node_report");
  await page.keyboard.press("Escape");
  await page.goto(`/worktrees/${id}/variables`);
  await page.getByRole("button", { name: "minimum", exact: true }).click();
  await expect(page.locator(".variable-usage-row")).toContainText("Filter");

  const base = await read();
  const current = structuredClone(base.bundle!);
  const proposal = structuredClone(base.bundle!);
  current.flow.nodes[1].params.condition = "amount > 10";
  proposal.flow.nodes[1].params.condition = "amount > 20";
  expect(
    (
      await page.request.put(url, {
        data: { revision: base.revision, bundle: current },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.put(url, {
        data: { revision: base.revision, bundle: proposal },
      })
    ).status(),
  ).toBe(409);
  await page.goto(`/worktrees/${id}/flow`);
  await page
    .getByRole("button", { name: "Save resolution", exact: true })
    .click();
  const conflict = page.getByRole("dialog", {
    name: "Concurrent edit conflict",
  });
  await expect(conflict.locator("pre.expression")).toHaveText(
    "Filter · condition",
  );
});
