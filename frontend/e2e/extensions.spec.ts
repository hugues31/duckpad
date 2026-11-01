import { test, expect } from "@playwright/test";
import {
  openInstanceSettings,
  openUserSettings,
  signIn,
  stubDuckDBWebsites,
} from "./helpers";
import fr from "../src/locales/fr.json" with { type: "json" };

test.use({
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
});

test.beforeEach(({ page }) => stubDuckDBWebsites(page));

test("a Windows browser downloads for the Linux server and sees invalid import errors", async ({
  page,
}) => {
  await signIn(page);
  const runtime = await (
    await page.request.get("/api/extensions/runtime")
  ).json();
  await openInstanceSettings(page, "Extensions");
  expect(await page.evaluate(() => navigator.userAgent)).toContain("Windows");
  await page.getByLabel("Extension name", { exact: true }).fill("httpfs");
  const link = page.getByRole("link", {
    name: "Download server binary",
    exact: true,
  });
  await expect(link).toHaveAttribute(
    "href",
    `https://extensions.duckdb.org/${runtime.version}/${runtime.platform}/httpfs.duckdb_extension.gz`,
  );
  // Picking a listed community extension selects its source too.
  await page.getByLabel("Extension name", { exact: true }).fill("h3");
  await page
    .getByRole("list", { name: "Available extensions", exact: true })
    .getByRole("button", { name: /^h3 / })
    .click();
  await expect(
    page.getByLabel("Extension source", { exact: true }),
  ).toHaveValue("community");
  await expect(link).toHaveAttribute(
    "href",
    `https://community-extensions.duckdb.org/${runtime.version}/${runtime.platform}/h3.duckdb_extension.gz`,
  );
  await page.getByLabel("Extension file", { exact: true }).setInputFiles({
    name: "h3.duckdb_extension.gz",
    mimeType: "application/gzip",
    buffer: Buffer.from("not a gzip file"),
  });
  await page
    .getByRole("button", { name: "Import extension", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("invalid or incomplete");
  expect(
    (await (await page.request.get("/api/extensions/runtime")).json()).imports,
  ).toEqual(runtime.imports);
  await openUserSettings(page);
  await page.getByLabel("Language", { exact: true }).selectOption("fr");
  await page.goto("/instance-settings/extensions");
  await expect(
    page.getByRole("heading", { name: fr.extensionDownloadStep }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: fr.extensionImport, exact: true }),
  ).toBeDisabled();
});

test("successful imports refresh the list and rejected replacements remain visible", async ({
  page,
}) => {
  await signIn(page);
  await openInstanceSettings(page, "Extensions");
  const runtime = await (
    await page.request.get("/api/extensions/runtime")
  ).json();
  let imported = false;
  await page.route("**/api/extensions/import", async (route) => {
    expect(route.request().headers()["content-type"]).toContain(
      "multipart/form-data",
    );
    expect(route.request().postData()).toContain(
      'filename="example.duckdb_extension"',
    );
    if (imported)
      return route.fulfill({
        status: 409,
        json: { error: "Stop active executions before importing extensions" },
      });
    imported = true;
    await route.fulfill({
      json: { ...runtime, imports: [{ name: "example", source: "core" }] },
    });
  });
  await page.getByLabel("Extension file", { exact: true }).setInputFiles({
    name: "example.duckdb_extension",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("test upload"),
  });
  const button = page.getByRole("button", {
    name: "Import extension",
    exact: true,
  });
  await button.click();
  await expect(page.getByRole("status")).toContainText("Extension imported.");
  await expect(
    page.getByRole("listitem").filter({ hasText: "example" }),
  ).toBeVisible();
  await button.click();
  await expect(page.getByRole("alert")).toContainText("Stop active executions");
  await expect(
    page.getByRole("listitem").filter({ hasText: "example" }),
  ).toBeVisible();
});
