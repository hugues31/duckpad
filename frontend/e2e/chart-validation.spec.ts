import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import type { Snapshot } from "../src/types";

test("the Chart tab lists the diagnostics of charts.json and opens the file in Code", async ({
  page,
}) => {
  await signIn(page);
  const example = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  const snapshot: Snapshot = await (
    await page.request.get(`/api/worktrees/${example.id}`)
  ).json();
  // An expression where a literal is expected: saved, but never rendered.
  const saved = await page.request.put(`/api/worktrees/${example.id}`, {
    data: {
      revision: snapshot.revision,
      bundle: {
        ...snapshot.bundle,
        charts: {
          "validated:orders": [
            {
              name: "Amount by channel",
              spec: {
                mark: "bar",
                encoding: {
                  x: { field: "channel", type: "nominal" },
                  y: { value: { expr: "alert(1)" } },
                },
              },
            },
          ],
        },
      },
    },
  });
  expect(saved.ok()).toBe(true);

  await page.goto(`/worktrees/${example.id}/flow?node=validated`);
  const panel = page.getByRole("region", { name: "Results", exact: true });
  await panel.getByRole("tab", { name: "Chart", exact: true }).click();
  const alert = panel.getByRole("alert");
  await expect(alert.getByRole("listitem")).toHaveText([
    "charts.json: chart Amount by channel of validated:orders: encoding.y.value must be a literal (a string, number, boolean or null)",
  ]);
  await expect(panel.locator(".chart-view")).toHaveCount(0);

  await alert.getByRole("link", { name: "Open charts.json in Code" }).click();
  await expect(page).toHaveURL(/\/code(\?|$)/);
  await expect(page.locator(".code-file-heading")).toContainText("charts.json");
  await expect(
    page
      .getByRole("tree", { name: "Project files" })
      .getByRole("treeitem", { name: "charts.json", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});
