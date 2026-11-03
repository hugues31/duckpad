import { expect, test, type Page } from "@playwright/test";
import { signIn, stubDuckDBWebsites } from "./helpers";

test.beforeEach(({ page }) => stubDuckDBWebsites(page));

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
  const unavailable = missing.getByRole("checkbox", {
    name: "Activate for this project",
    exact: true,
  });
  await expect(unavailable).toBeDisabled();
  await expect(unavailable).not.toBeChecked();
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
  const activation = json.getByRole("checkbox", {
    name: "Activate for this project",
    exact: true,
  });
  await expect(activation).not.toBeChecked();
  await activation.click();
  await expect(json.getByRole("status")).toHaveText("Active for this project");
  await expect(activation).toBeChecked();
  await page.reload();
  await expect(json.getByRole("status")).toHaveText("Active for this project");
  await expect(activation).toBeChecked();
  // Row actions are icon buttons named by their tooltip.
  const check = json.getByRole("button", {
    name: "Check loading",
    exact: true,
  });
  await check.hover();
  await expect
    .poll(() =>
      check.evaluate((element) => getComputedStyle(element, "::after").opacity),
    )
    .toBe("1");
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
  await activation.click();
  await expect(json.getByRole("status")).toHaveText("Ready to activate");
  await expect(activation).not.toBeChecked();
});

test("editors pick listed extensions and enter exact names when the browser is offline", async ({
  page,
}) => {
  await project(page);
  const name = page.getByLabel("Extension name", { exact: true });
  const source = page.getByLabel("Extension source", { exact: true });
  const catalog = page.getByRole("list", {
    name: "Available extensions",
    exact: true,
  });
  const pick = (extension: string) =>
    catalog.getByRole("button", { name: new RegExp(`^${extension} `) });
  await expect(
    page.getByRole("link", { name: "Community extension list", exact: true }),
  ).toHaveAttribute(
    "href",
    "https://duckdb.org/community_extensions/list_of_extensions",
  );
  // Core extensions come from the server's DuckDB, community ones from the browser.
  await expect(pick("httpfs")).toContainText("DuckDB core");
  await expect(pick("h3")).toContainText("DuckDB community");
  await name.fill("hex");
  await expect(catalog.getByRole("button")).toHaveCount(1);
  await pick("h3").click();
  await expect(name).toHaveValue("h3");
  await expect(source).toHaveValue("community");
  await expect(pick("h3")).toHaveAttribute("aria-current", "true");
  const runtime = await (
    await page.request.get("/api/extensions/runtime")
  ).json();
  const availability = page.locator(".extension-availability");
  await expect(availability).toHaveText(
    `Download available for the server: ${runtime.version} / ${runtime.platform}`,
  );
  await page
    .getByRole("button", { name: "Add extension", exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "h3", exact: true }).getByRole("status"),
  ).toHaveText("Import required");
  await name.fill("gsheets");
  await pick("gsheets").click();
  await expect(availability).toContainText(
    "No download published for the server",
  );
  // Aliases find core extensions, and built-in ones need no download.
  await name.fill("postgres");
  await expect(catalog.getByRole("button").first()).toHaveAccessibleName(
    /^postgres_scanner /,
  );
  await name.fill("json");
  await source.selectOption("core");
  await expect(pick("json")).toContainText("built in");
  await expect(availability).toHaveText(
    "Built into the server's DuckDB: no download or import needed.",
  );

  await page.unrouteAll();
  await stubDuckDBWebsites(page, { offline: true });
  await page.reload();
  await expect(page.getByText(/cannot load the community list/)).toBeVisible();
  await expect(pick("httpfs")).toBeVisible();
  await expect(pick("duckfn_statrs")).toHaveCount(0);
  // Without a connection the download check stays silent.
  const probe = page.waitForEvent("requestfailed", (request) =>
    request.url().includes("community-extensions.duckdb.org"),
  );
  await name.fill("duckfn_statrs");
  await source.selectOption("community");
  await probe;
  await expect(availability).toBeEmpty();
  await page
    .getByRole("button", { name: "Add extension", exact: true })
    .click();
  await expect(
    page
      .getByRole("article", { name: "duckfn_statrs", exact: true })
      .getByRole("status"),
  ).toHaveText("Import required");
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
    .getByRole("checkbox", { name: "Activate for this project", exact: true })
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
