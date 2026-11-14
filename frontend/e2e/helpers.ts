import { expect, type Locator, type Page } from "@playwright/test";
import en from "../src/locales/en.json" with { type: "json" };
import type { Bundle, Snapshot } from "../src/types";

/** Administrator password of the disposable instance started by scripts/e2e_server.py. */
export const PASSWORD = "duckpad-browser-test";

/**
 * Open the project overview of the Documentation tab for editing and return
 * its editor: the tab shows the rendered document until asked.
 */
export async function editOverview(page: Page) {
  await page
    .locator(".documentation-page")
    .getByRole("button", { name: "Edit overview", exact: true })
    .click();
  return page.locator(".project-documentation");
}

/** Drop a palette definition into the uncovered canvas, including narrow layouts. */
export async function dragPaletteNode(page: Page, label: string) {
  const pane = page.locator(".react-flow__pane");
  const bounds = (await pane.boundingBox())!;
  const point = await page.locator(".canvas-safe-area").evaluate((element) => {
    const area = element.getBoundingClientRect();
    const nodes = Array.from(
      document.querySelectorAll(".react-flow__node"),
    ).map((node) => node.getBoundingClientRect());
    // Each drop has its own space so later steps can select every created node.
    for (let y = area.bottom - 100; y >= area.top + 70; y -= 70) {
      for (let x = area.right - 100; x >= area.left + 70; x -= 70) {
        if (
          nodes.some(
            (node) =>
              node.left < x + 110 &&
              node.right > x - 70 &&
              node.top < y + 110 &&
              node.bottom > y - 70,
          )
        )
          continue;
        if (
          document
            .elementFromPoint(x, y)
            ?.classList.contains("react-flow__pane")
        )
          return { x, y };
      }
    }
    throw new Error("No empty canvas area for the palette drop");
  });
  await page
    .locator(".palette-list")
    .getByRole("button", { name: label, exact: true })
    .dragTo(pane, {
      targetPosition: {
        x: point.x - bounds.x,
        y: point.y - bounds.y,
      },
    });
}

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
 * Leaving the focused field saves it without waiting for the typing pause;
 * `keepFocus` leaves the focus where a canvas gesture put it.
 */
export async function autosaved(
  page: Page,
  edit: () => Promise<unknown>,
  keepFocus = false,
) {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      /^\/api\/worktrees\/[^/]+$/.test(new URL(response.url()).pathname),
  );
  await edit();
  if (!keepFocus)
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

/** The canvas zoom, read from React Flow's viewport transform. */
export const canvasZoom = (page: Page) =>
  page
    .locator(".react-flow__viewport")
    .evaluate(
      (viewport) => new DOMMatrix(getComputedStyle(viewport).transform).a,
    );

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

/**
 * Replace the text of the file open in the Code tab through the clipboard.
 * A newly selected file mounts a hidden editor, which ignores focus and
 * reports no changes until it shows.
 */
export async function editCode(page: Page, text: string) {
  const editor = page.locator(".code-workspace .monaco-editor");
  await expect(editor).toBeVisible();
  await editor.locator("textarea").focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press("ControlOrMeta+V");
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

export async function openUserSettings(page: Page, section?: string) {
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "User settings", exact: true })
    .click();
  if (section)
    await page
      .getByRole("navigation", { name: "Settings sections", exact: true })
      .getByRole("link", { name: section, exact: true })
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

/** Choose one of the selected node's actions in the inspector. */
export async function nodeMenuAction(page: Page, name: string) {
  await page
    .locator(".inspector")
    .getByRole("group", { name: "Node actions", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
}

/** A promise resolved by the test, to hold a request until a given step. */
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

/**
 * Sign in to a new project Rows → Filter (`filtered`) → Output, whose Output
 * keeps one column and has a warning test; open its flow on the Filter.
 */
export async function createFilterProject(
  page: Page,
  change?: (bundle: Bundle) => void,
) {
  await signIn(page);
  const created = await page.request.post("/api/projects", {
    data: { name: "Filtered rows" },
  });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  const endpoint = `/api/worktrees/${id}`;
  const read = async (): Promise<Snapshot> =>
    (await page.request.get(endpoint)).json();
  const initial = await read();
  const bundle = initial.bundle!;
  bundle.templates.rows =
    "-- @label Rows\n-- @output result\nSELECT 1 AS amount, 'input' AS input_only;";
  bundle.templates.output =
    "-- @label Output\n-- @input source\n-- @output result\nSELECT amount FROM {{ source }};\n-- @test rejected: warning\nSELECT * FROM {{ result }} WHERE amount > 0;";
  bundle.flow.nodes = [
    { id: "rows", template: "rows", params: {}, position: { x: 0, y: 0 } },
    {
      id: "filtered",
      template: "filter",
      params: { condition: "true" },
      position: { x: 350, y: 0 },
    },
    {
      id: "output",
      template: "output",
      params: {},
      position: { x: 700, y: 0 },
    },
  ];
  bundle.flow.edges = [
    {
      id: "first",
      source: "rows",
      sourceHandle: "result",
      target: "filtered",
      targetHandle: "source",
    },
    {
      id: "second",
      source: "filtered",
      sourceHandle: "result",
      target: "output",
      targetHandle: "source",
    },
  ];
  change?.(bundle);
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: initial.revision, bundle },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/worktrees/${id}/flow?node=filtered`);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  return { id: id as string, endpoint, read };
}
