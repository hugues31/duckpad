import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";

async function project(page: Page) {
  await signIn(page);
  const result = await page.request.post("/api/projects", {
    data: { name: "Project extensions" },
  });
  expect(result.ok()).toBeTruthy();
  const worktree = await result.json();
  await page.goto(`/worktrees/${worktree.id}/extensions`);
  return worktree.id as string;
}

async function add(page: Page, name: string, source: string) {
  await page.getByLabel("Extension name", { exact: true }).fill(name);
  await page
    .getByLabel("Extension source", { exact: true })
    .selectOption(source);
  await page
    .getByRole("button", { name: "Add extension", exact: true })
    .click();
  return page.getByRole("article", { name, exact: true });
}

test("project extensions distinguish missing imports, check loading and persist activation", async ({
  page,
}) => {
  const identity = await project(page);
  const missing = await add(page, "missing_capability", "community");
  await expect(missing.getByRole("status")).toHaveText("Import required");
  await expect(
    missing.getByRole("button", {
      name: "Activate for this project",
      exact: true,
    }),
  ).toBeDisabled();
  const runtime = await (
    await page.request.get(`/api/worktrees/${identity}/extensions`)
  ).json();
  await expect(
    missing.getByRole("link", { name: "Download server binary" }),
  ).toHaveAttribute(
    "href",
    `https://community-extensions.duckdb.org/${runtime.version}/${runtime.platform}/missing_capability.duckdb_extension.gz`,
  );
  await missing.getByRole("link", { name: "Open instance import" }).click();
  await expect(page.getByLabel("Extension name", { exact: true })).toHaveValue(
    "missing_capability",
  );
  await expect(
    page.getByLabel("Extension source", { exact: true }),
  ).toHaveValue("community");
  await page.goto(`/worktrees/${identity}/extensions`);
  const json = await add(page, "json", "core");
  await expect(json.getByRole("status")).toHaveText("Ready to activate");
  await json
    .getByRole("button", { name: "Activate for this project", exact: true })
    .click();
  await expect(json.getByRole("status")).toHaveText("Active for this project");
  await page.reload();
  await expect(json.getByRole("status")).toHaveText("Active for this project");
  // A loading failure is explicit and does not discard the portable requirement.
  await page.route("**/extensions/check", (route) =>
    route.fulfill({
      status: 422,
      json: {
        error: "Extension loading failed: a native dependency is missing",
      },
    }),
  );
  await json
    .getByRole("button", { name: "Check loading", exact: true })
    .click();
  await expect(json.getByRole("status")).toHaveText("Loading failed");
  await expect(page.getByRole("alert")).toContainText("native dependency");
  const snapshot = await (
    await page.request.get(`/api/worktrees/${identity}`)
  ).json();
  expect(snapshot.bundle.extensions.json).toEqual({
    source: "core",
    enabled: true,
  });
  await page.unroute("**/extensions/check");
  await json
    .getByRole("button", { name: "Check loading", exact: true })
    .click();
  await expect(json.getByRole("status")).toHaveText("Active for this project");
  await json
    .getByRole("button", { name: "Deactivate for this project", exact: true })
    .click();
  await expect(json.getByRole("status")).toHaveText("Ready to activate");
});

test("a downloaded community binary is imported and activated without a connection", async ({
  page,
}) => {
  const binary = process.env.DUCKPAD_TEST_STATRS_BINARY;
  test.skip(
    !binary,
    "Set DUCKPAD_TEST_STATRS_BINARY to a compatible downloaded binary for the integration check",
  );
  const identity = await project(page);
  const stats = await add(page, "duckfn_statrs", "community");
  await stats.getByRole("link", { name: "Open instance import" }).click();
  await page
    .getByLabel("Extension file", { exact: true })
    .setInputFiles(binary!);
  await page
    .getByRole("button", { name: "Import extension", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Extension imported");
  await page.goto(`/worktrees/${identity}/extensions`);
  await stats
    .getByRole("button", { name: "Activate for this project", exact: true })
    .click();
  await expect(stats.getByRole("status")).toHaveText("Active for this project");
  const url = `/api/worktrees/${identity}`;
  const snapshot = await (await page.request.get(url)).json();
  snapshot.bundle.flow.nodes = [
    { id: "statistics", template: "statistics", params: {} },
  ];
  snapshot.bundle.templates.statistics =
    "-- @label Statistical functions\n-- @kind source\n-- @output result\nSELECT sr_normal_cdf(0.0, 0.0, 1.0) AS cdf_0, sr_normal_cdf(1.96, 0.0, 1.0) AS cdf_196, sr_normal_pdf(0.0, 0.0, 1.0) AS pdf_0, sr_normal_quantile(0.975, 0.0, 1.0) AS quantile_975;";
  expect(
    (
      await page.request.put(url, {
        data: { revision: snapshot.revision, bundle: snapshot.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await page.getByRole("link", { name: "Flow", exact: true }).click();
  await page.getByRole("button", { name: "Run pipeline", exact: true }).click();
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `${url}/preview/statistics?environment=dev`,
      );
      return response.ok() ? (await response.json()).rows[0]?.values : null;
    })
    .toEqual([
      0.5, 0.9750021048529024, 0.39894228040143265, 1.9599639845400538,
    ]);
  await page
    .locator(".react-flow__node")
    .filter({ hasText: "Statistical functions" })
    .click();
  await expect(page.getByRole("columnheader", { name: /cdf_0/ })).toBeVisible();
});
