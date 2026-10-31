import { expect, type Page } from "@playwright/test";
import en from "../src/locales/en.json" with { type: "json" };

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
}

export async function openInstanceSettings(
  page: Page,
  section = "Users and permissions",
) {
  await page
    .getByRole("link", { name: "Instance settings", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "Instance settings", exact: true })
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
