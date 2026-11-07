import { expect, type Locator, type Page } from "@playwright/test";
import en from "../src/locales/en.json" with { type: "json" };
import type { Snapshot } from "../src/types";

/** Administrator password of the disposable instance started by scripts/e2e_server.py. */
export const PASSWORD = "duckpad-browser-test";

type LoginLabels = Pick<typeof en, "password" | "signInAction" | "workspace">;

/** Submit the login form shown in the given language and wait for the workspace. */
export async function submitLogin(page: Page, labels: LoginLabels = en) {
  await page.getByLabel(labels.password, { exact: true }).fill(PASSWORD);
  await page
    .getByRole("button", { name: labels.signInAction, exact: true })
    .click();
  await expect(
    page.getByRole("navigation", { name: labels.workspace, exact: true }),
  ).toBeVisible();
}

export async function signIn(page: Page) {
  await page.goto("/");
  await submitLogin(page);
  // The navigation rail appears before the workspace loads and redirects home.
  await expect(
    page.getByRole("heading", { name: en.projects, exact: true }),
  ).toBeVisible();
}

/**
 * Make edits that the flow saves by itself, and wait until they are saved.
 * Leaving the focused field saves it without waiting for the typing pause.
 */
export async function autosaved(page: Page, edit: () => Promise<unknown>) {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      /^\/api\/worktrees\/[^/]+$/.test(new URL(response.url()).pathname),
  );
  await edit();
  await page.evaluate(() =>
    (document.activeElement as HTMLElement | null)?.blur(),
  );
  expect((await saved).ok()).toBeTruthy();
  await expect(page.locator(".save-status")).toHaveText("All changes saved");
}

/**
 * Close a code editor dialog, which saves its pending edits before closing.
 * A Python save also resolves the project's lock, which takes longer.
 */
export async function closeEditor(dialog: Locator) {
  await dialog
    .locator("footer")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(dialog).toHaveCount(0, { timeout: 30000 });
}

/** The selected node's code, docked beside the canvas in the inspector's place. */
export const codePanel = (page: Page) =>
  page.getByRole("complementary", { name: "Code editor", exact: true });

/** Open the selected node's code with an inspector button and wait for its editor. */
export async function openCode(page: Page, button = "Edit code") {
  await page
    .locator(".inspector")
    .getByRole("button", { name: button, exact: true })
    .click();
  const panel = codePanel(page);
  await expect(panel.locator(".monaco-editor")).toBeVisible();
  return panel;
}

/**
 * Make an edit in the code panel and wait until the pause after it saved it.
 * A Python save also resolves the project's lock, which takes longer.
 */
export async function codeSaved(page: Page, edit: () => Promise<unknown>) {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      /^\/api\/worktrees\/[^/]+$/.test(new URL(response.url()).pathname),
    { timeout: 30000 },
  );
  await edit();
  expect((await saved).ok()).toBeTruthy();
  await expect(codePanel(page).locator(".editor-save-state")).toHaveText(
    "All changes saved",
    { timeout: 30000 },
  );
}

/** Replace the code shown in the code panel and wait until it is saved. */
export async function replaceCode(page: Page, text: string) {
  await codeSaved(page, async () => {
    await codePanel(page).locator(".monaco-editor textarea").focus();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(text);
  });
}

/** Close the code panel: the inspector takes its place again. */
export async function closeCode(page: Page) {
  const panel = codePanel(page);
  await panel
    .getByRole("button", { name: "Close the code editor", exact: true })
    .click();
  await expect(panel).toHaveCount(0);
  await expect(page.locator(".inspector")).toBeVisible();
}

/** Fetch only refreshes the remote status, so it stays under the synchronization details. */
export async function fetchOrigin(dialog: Locator) {
  const fetch = dialog.getByRole("button", { name: "Fetch", exact: true });
  if (!(await fetch.isVisible()))
    await dialog.locator(".git-sync-details > summary").click();
  await fetch.click();
}

export async function openInstanceSettings(
  page: Page,
  section = "Users and permissions",
) {
  await page
    .getByRole("link", { name: "Instance settings", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("link", { name: section, exact: true })
    .click();
}

export async function openUserSettings(page: Page) {
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "User settings", exact: true })
    .click();
}

/**
 * Answer the browser's requests to DuckDB's websites, so that tests never
 * depend on them: the community list holds these extensions, and only the
 * `published` downloads exist. Offline, every request fails.
 */
export async function stubDuckDBWebsites(
  page: Page,
  {
    community = {
      h3: "Hierarchical hexagonal indexing for geospatial data",
      duckfn_statrs: "Statistical distribution functions",
      gsheets: "Read and write Google Sheets",
    },
    published = ["httpfs", "h3", "duckfn_statrs"],
    offline = false,
  }: {
    community?: Record<string, string>;
    published?: string[];
    offline?: boolean;
  } = {},
) {
  const rows = Object.entries(community)
    .map(([name, text]) => `<tr><td>${name}</td><td></td><td>${text}</td></tr>`)
    .join("");
  await page.route(
    (url) =>
      url.hostname === "duckdb.org" || url.hostname.endsWith(".duckdb.org"),
    (route) => {
      if (offline) return route.abort("internetdisconnected");
      const url = new URL(route.request().url());
      const headers = { "access-control-allow-origin": "*" };
      if (url.hostname === "duckdb.org")
        return route.fulfill({
          headers,
          contentType: "text/html",
          body: `<table><tbody>${rows}</tbody></table>`,
        });
      const name = url.pathname.split("/").pop()!.split(".")[0];
      return route.fulfill({
        headers,
        status: published.includes(name) ? 200 : 404,
      });
    },
  );
}

/**
 * Remove the Northstar example's variables, their references and its shared view,
 * for variable workflows that start from a project without variables.
 */
export function withoutExampleVariables(
  bundle: NonNullable<Snapshot["bundle"]>,
) {
  const params = (id: string) =>
    bundle.flow.nodes.find((node) => node.id === id)!.params;
  delete params("validated").review_threshold;
  params("premium").condition = "amount >= 300";
  params("export").destination = "regional-revenue.csv";
  params("export_premium").destination = "high-value-orders.csv";
  delete bundle.variables;
  delete bundle.views;
}

/** Choose an inspector action from the same menu used by the canvas. */
export async function nodeMenuAction(page: Page, name: string) {
  await page
    .locator(".inspector")
    .getByRole("button", { name: "Node actions", exact: true })
    .click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
