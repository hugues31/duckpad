import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  openInstanceSettings,
  openUserSettings,
  PASSWORD,
  signIn,
  stubDuckDBWebsites,
} from "../e2e/helpers";

// All scenes use the real application and disposable, synthetic fixtures.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("duckpad-theme", "light");
    localStorage.setItem("duckpad-language", "en");
  });
  await signIn(page);
});

async function capture(
  page: Page,
  name: string,
  region: Page | Locator = page,
  extraStyle = "",
) {
  await mkdir(resolve("../docs/images"), { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  await region.screenshot({
    path: resolve("../docs/images", `${name}.png`),
    animations: "disabled",
    caret: "hide",
    // Hide transient notifications and variable Git metadata, not product state.
    style:
      ".toast, .resource-monitor, .git-revisions small { visibility: hidden !important; }" +
      extraStyle,
  });
}

function node(page: Page, label: string) {
  return page.locator(".react-flow__node").filter({
    has: page.getByText(label, { exact: true }),
  });
}

async function example(page: Page) {
  const response = await page.request.post("/api/example", {
    data: { name: "Northstar" },
  });
  expect(response.ok()).toBeTruthy();
  const worktree = await response.json();
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await expect(page.locator(".react-flow__node")).toHaveCount(9);
  return worktree;
}

async function run(page: Page) {
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/runs") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Run pipeline", exact: true }).click();
  const result = await response;
  expect(result.ok()).toBeTruthy();
  const execution = await result.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${execution.id}`)).json())
          .status,
      { timeout: 30000 },
    )
    .toBe("success");
}

test("capture project creation, results, lineage and SQL", async ({ page }) => {
  await page.getByRole("button", { name: "New project", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New project", exact: true });
  await dialog.getByLabel("Name", { exact: true }).fill("Northstar");
  await dialog.getByRole("radio", { name: "Start from an example" }).check();
  await expect(
    dialog.getByRole("button", { name: "Create", exact: true }),
  ).toBeEnabled();
  await capture(page, "new-project", dialog);
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(9);
  await run(page);
  await node(page, "Regional revenue").click();
  await page.getByLabel("Output", { exact: true }).selectOption("report");
  const revenue = page.getByRole("button", {
    name: /Explain this value: revenue, rows 1,/,
  });
  await expect(revenue).toBeVisible();
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  await capture(page, "workspace");
  await revenue.click();
  const lineage = page.getByRole("dialog", {
    name: "How this value was calculated",
  });
  await expect(lineage).toContainText("Sum of 27 contributing values", {
    ignoreCase: true,
  });
  await expect(lineage.locator(".lineage-card.is-source")).toHaveCount(5);
  await capture(page, "lineage", lineage);
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "Code", exact: true }).click();
  await page
    .getByRole("treeitem", { name: "templates/sql.sql", exact: true })
    .click();
  await expect(page.locator(".code-file-heading")).toContainText(
    "templates/sql.sql",
  );
  await expect(page.locator(".monaco-editor .view-lines")).toContainText(
    "SELECT",
  );
  await capture(page, "code");
});

test("capture parameters, node documentation and nested components", async ({
  page,
}) => {
  await example(page);
  await run(page);
  await node(page, "Paid orders").click();
  await page.getByLabel("Output", { exact: true }).selectOption("orders");
  const inspector = page.locator(".inspector");
  await expect(inspector.getByRole("textbox", { name: /status/ })).toHaveValue(
    "paid",
  );
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  await capture(page, "parameters");
  await inspector
    .getByRole("button", { name: "Documentation", exact: true })
    .click();
  await expect(inspector.locator(".documentation-editor")).not.toHaveValue("");
  await capture(page, "node-documentation");
  await node(page, "Customer reach").click();
  await expect(
    inspector.getByRole("button", { name: "Edit code", exact: true }),
  ).toBeVisible();
  await capture(page, "node-code");
  await node(page, "Regional revenue").dblclick();
  await expect(
    page.getByText(
      "You are editing a shared component definition in this branch.",
    ),
  ).toBeVisible();
  await node(page, "Regional summary").dblclick();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await node(page, "Revenue by region").click();
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  await capture(page, "component");
});

test("capture project variables, a parameter binding and a run confirmation", async ({
  page,
}) => {
  const worktree = await example(page);
  const url = `/api/worktrees/${worktree.id}`;
  const snapshot = await (await page.request.get(url)).json();
  snapshot.bundle.variables = {
    high_value_threshold: {
      type: "number",
      description: "Minimum order amount kept by the high-value report.",
      default: 300,
      environments: { prod: 900 },
    },
    order_status: {
      type: "choice(paid|refunded|pending)",
      description: "Order status counted as revenue.",
      default: "paid",
    },
    report_start: {
      type: "date",
      description: "First order date included in the reports.",
      default: "2026-10-01",
      environments: { prod: "2026-01-01" },
    },
    oracle_schema: {
      type: "identifier",
      description: "Schema of the Oracle sales tables.",
      default: "DEMO",
      environments: { prod: "SALES" },
    },
  };
  const saved = await page.request.put(url, {
    data: { revision: snapshot.revision, bundle: snapshot.bundle },
  });
  expect(saved.ok()).toBeTruthy();
  await run(page);
  await node(page, "Paid orders").click();
  await page.getByLabel("Output", { exact: true }).selectOption("orders");
  await expect(page.locator(".preview-header .badge")).toHaveText("Valid");
  const inspector = page.locator(".inspector");
  await inspector
    .getByRole("button", { name: "Bind status to a variable", exact: true })
    .click();
  const picker = inspector.getByRole("group", {
    name: "Bind status to a variable",
  });
  await expect(picker).toContainText("paid in every environment");
  await expect(picker).toContainText("identifier · incompatible");
  await capture(page, "variable-binding");
  await picker.getByRole("button", { name: /^order_status/ }).click();
  await expect(
    inspector.getByRole("group", { name: "status is bound to order_status" }),
  ).toContainText("= paid in dev");
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Variables", exact: true }).click();
  await page
    .locator(".variables-table")
    .getByRole("button", { name: "order_status" })
    .click();
  const editor = page.getByRole("complementary", { name: "order_status" });
  await editor
    .getByRole("switch", { name: "Use the default value in dev" })
    .click();
  await editor.getByLabel("dev value", { exact: true }).selectOption("pending");
  await expect(editor.getByRole("status")).toContainText(
    "Saving marks Paid orders and 5 descendants as stale in dev.",
  );
  await capture(page, "variables");
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();

  await page.getByLabel("Environment", { exact: true }).selectOption("prod");
  await page.getByRole("button", { name: "Run pipeline", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "Confirm execution" });
  await expect(
    confirmation.getByRole("row").filter({ hasText: "order_status" }),
  ).toContainText("paid");
  await capture(page, "run-variables", confirmation);
  await confirmation
    .getByRole("button", { name: "Cancel", exact: true })
    .click();

  // An expression references a variable and shows its value per environment.
  await page.getByRole("link", { name: "Flow", exact: true }).click();
  await node(page, "High-value orders").click();
  const condition = inspector.getByRole("textbox", { name: /condition/ });
  await condition.fill("amount >= ");
  await condition.pressSequentially("{{ var.high");
  await expect(
    inspector.getByRole("listbox", { name: "Variables" }),
  ).toContainText("high_value_threshold");
  await condition.press("Enter");
  await expect(
    inspector.getByRole("list", { name: "Variables used by this expression" }),
  ).toContainText("prod 900");
  await inspector
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  await capture(page, "variable-expression");
});

test("capture connection setup and environment policies", async ({ page }) => {
  await openInstanceSettings(page, "Connections");
  await page
    .getByRole("button", { name: "New connection", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("ID", { exact: true }).fill("xlsx");
  await dialog.getByLabel("Name", { exact: true }).fill("Excel reports");
  await dialog
    .getByRole("combobox", { name: "Connector", exact: true })
    .selectOption("xlsx");
  await expect(dialog.getByLabel("root", { exact: true })).toHaveValue("");
  await capture(page, "connection", dialog);
  await page.keyboard.press("Escape");
  await openInstanceSettings(page, "Environments");
  await expect(page.locator(".environment-card")).toHaveCount(2);
  await expect(
    page.getByRole("article", { name: "prod", exact: true }),
  ).toContainText("Confirm every run");
  await capture(page, "environments", page.locator(".settings-layout"));
});

test("capture branch creation and a real parameter comparison", async ({
  page,
}) => {
  await example(page);
  await page.getByTitle("New working branch", { exact: true }).click();
  const branch = page.getByRole("dialog", {
    name: "New working branch",
    exact: true,
  });
  await branch
    .getByLabel("Branch name", { exact: true })
    .fill("experiment/refunded-orders");
  await expect(
    branch.getByRole("button", { name: "Create", exact: true }),
  ).toBeEnabled();
  await capture(page, "new-branch", branch);
  await branch.getByRole("button", { name: "Create", exact: true }).click();
  await expect(branch).toBeHidden();
  await node(page, "Paid orders").click();
  const status = page
    .locator(".inspector")
    .getByRole("textbox", { name: /status/ });
  await status.fill("refunded");
  await status.blur();
  const worktree = new URL(page.url()).pathname.split("/")[2];
  await expect
    .poll(async () => {
      const snapshot = await (
        await page.request.get(`/api/worktrees/${worktree}`)
      ).json();
      return snapshot.bundle.flow.nodes.find(
        (n: { label: string }) => n.label === "Paid orders",
      ).params.status;
    })
    .toBe("refunded");
  // Keep both revision selectors and the before/after values in the image.
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page
    .getByRole("button", { name: "Git synchronization", exact: true })
    .click();
  const git = page.getByRole("dialog", { name: "Project Git workspace" });
  await git
    .getByRole("button", { name: "Compare versions", exact: true })
    .first()
    .click();
  await git.getByLabel("A: reference").fill("main");
  await git.getByLabel("B: target").fill("experiment/refunded-orders");
  await expect(git.locator(".change-list")).toContainText("Paid orders");
  await git.locator(".change-row").filter({ hasText: "Paid orders" }).click();
  await expect(git.locator(".comparison-values")).toContainText("refunded");
  await expect(git.locator(".comparison-values")).toContainText("paid");
  await expect(
    git.locator(".comparison-values tr").filter({ hasText: "refunded" }),
  ).toBeInViewport({ ratio: 1 });
  await capture(page, "git-comparison", git);
});

test("capture account roles, project access and personal preferences", async ({
  page,
}) => {
  await openInstanceSettings(page, "Users and permissions");
  for (const username of ["analyst", "reviewer"]) {
    await page.getByRole("button", { name: "Add user", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add user", exact: true });
    await dialog.getByLabel("Username", { exact: true }).fill(username);
    await dialog.getByLabel("New password", { exact: true }).fill(PASSWORD);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByLabel(`Instance role · ${username}`, { exact: true }),
    ).toHaveValue("member");
  }
  await capture(page, "users", page.locator(".settings-layout"));
  const users = await (await page.request.get("/api/users")).json();
  const created = await page.request.post("/api/projects", {
    data: { name: "Team workspace" },
  });
  expect(created.ok()).toBeTruthy();
  const worktree = await created.json();
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await page
    .getByRole("link", { name: "Project settings", exact: true })
    .click();
  for (const [username, role] of [
    ["analyst", "editor"],
    ["reviewer", "reader"],
  ]) {
    const user = users.find(
      (user: { username: string }) => user.username === username,
    );
    await page.getByLabel("User", { exact: true }).selectOption(user.id);
    await page.getByLabel("Project role", { exact: true }).selectOption(role);
    await page
      .getByRole("button", { name: "Add participant", exact: true })
      .click();
    await expect(
      page.getByLabel(`Project role · ${username}`, { exact: true }),
    ).toHaveValue(role);
  }
  const participants = page.locator(".settings-card").filter({
    has: page.getByRole("heading", { name: "Participants", exact: true }),
  });
  await capture(page, "project-access", participants);
  await openUserSettings(page);
  await expect(page.getByLabel("Language", { exact: true })).toHaveValue("en");
  await expect(page.getByLabel("Theme", { exact: true })).toHaveValue("light");
  await capture(
    page,
    "preferences",
    page.locator(".settings-card").filter({
      has: page.getByRole("heading", { name: "Preferences", exact: true }),
    }),
  );
});

test("capture offline extension download and import settings", async ({
  page,
}) => {
  await stubDuckDBWebsites(page);
  const runtime = await (
    await page.request.get("/api/extensions/runtime")
  ).json();
  await openInstanceSettings(page, "Extensions");
  await page
    .getByLabel("Extension source", { exact: true })
    .selectOption("core");
  await page.getByLabel("Extension name", { exact: true }).fill("httpfs");
  await expect(
    page.getByRole("link", { name: "Download server binary", exact: true }),
  ).toHaveAttribute(
    "href",
    `https://extensions.duckdb.org/${runtime.version}/${runtime.platform}/httpfs.duckdb_extension.gz`,
  );
  await expect(
    page.getByText("Download available for the server"),
  ).toBeVisible();
  await expect(
    page.getByLabel("Allow unsigned extensions", { exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole("button", { name: "Import extension", exact: true }),
  ).toBeDisabled();
  await capture(page, "extensions", page.locator(".settings-layout"));
});

test("capture project extension activation and missing imports", async ({
  page,
}) => {
  await stubDuckDBWebsites(page);
  const response = await page.request.post("/api/projects", {
    data: { name: "Project capabilities" },
  });
  expect(response.ok()).toBeTruthy();
  const worktree = await response.json();
  const url = `/api/worktrees/${worktree.id}`;
  const snapshot = await (await page.request.get(url)).json();
  snapshot.bundle.extensions = {
    json: { source: "core", enabled: true },
    duckfn_statrs: { source: "community", enabled: false },
  };
  expect(
    (
      await page.request.put(url, {
        data: { revision: snapshot.revision, bundle: snapshot.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/worktrees/${worktree.id}/extensions`);
  await expect(
    page
      .getByRole("article", { name: "json", exact: true })
      .getByRole("status"),
  ).toHaveText("Active for this project");
  await expect(
    page
      .getByRole("article", { name: "duckfn_statrs", exact: true })
      .getByRole("status"),
  ).toHaveText("Import required");
  await expect(page.getByText(/choose an extension to fill in/)).toBeVisible();
  await capture(
    page,
    "project-extensions",
    page.locator(".project-extensions-page"),
  );
});

test("capture SSO configuration and the enabled sign-in choice", async ({
  page,
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 1100, height: 1000 },
    locale: "en-US",
    colorScheme: "light",
    reducedMotion: "reduce",
  });
  try {
    await openInstanceSettings(page, "Single sign-on (OIDC)");
    const settings = page.getByRole("region", {
      name: "Single sign-on (OIDC)",
      exact: true,
    });
    await settings.getByLabel("Enable single sign-on", { exact: true }).check();
    await settings
      .getByLabel("Sign-in button label", { exact: true })
      .fill("Northstar");
    // Document public example values in the real form before saving the local test provider.
    await settings
      .getByLabel("Issuer URL", { exact: true })
      .fill("https://identity.example.com/realms/team");
    await settings.getByLabel("Client ID", { exact: true }).fill("duckpad");
    const secret = settings.getByLabel("Client secret", { exact: true });
    await secret.fill("documentation-example");
    await expect(secret).toHaveAttribute("type", "password");
    await settings
      .getByLabel("Application URL", { exact: true })
      .fill("https://duckpad.example.com");
    await expect(
      settings.getByLabel("Redirect URI", { exact: true }),
    ).toHaveValue("https://duckpad.example.com/api/oidc/callback");
    await expect(
      settings.getByRole("button", { name: "Save changes", exact: true }),
    ).toBeEnabled();
    await capture(page, "sso-settings", page.locator(".settings-layout"));

    // The fixture validates discovery and completes a signed OIDC flow without external services.
    await settings
      .getByLabel("Issuer URL", { exact: true })
      .fill(baseURL + "/test-oidc");
    await settings.getByLabel("Client ID", { exact: true }).fill("test-client");
    await secret.fill("test-secret");
    await settings
      .getByLabel("Application URL", { exact: true })
      .fill(baseURL!);
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(settings.getByRole("status")).toContainText(
      "SSO settings saved",
    );
    await expect(secret).toHaveValue("");
    const login = await context.newPage();
    await login.goto("/");
    const sso = login.getByRole("link", {
      name: "Continue with Northstar",
      exact: true,
    });
    await expect(sso).toBeVisible();
    await expect(
      login.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(login.getByLabel("Password", { exact: true })).toHaveValue("");
    await capture(login, "sso-sign-in", login.locator(".login-card"));
    await sso.click();
    await login
      .getByRole("link", { name: "Approve test sign-in", exact: true })
      .click();
    await expect(
      login.getByRole("navigation", { name: "Workspace", exact: true }),
    ).toBeVisible();
    const session = await (await login.request.get("/api/session")).json();
    expect(session.auth_method).toBe("oidc");
    expect(session.role).toBe("member");
  } finally {
    await context.close();
    expect(
      (await page.request.put("/api/sso", { data: { enabled: false } })).ok(),
    ).toBeTruthy();
  }
});

test("assistant settings and contextual chat", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1250 });
  const response = await page.request.put("/api/assistant/settings", {
    data: {
      enabled: true,
      allow_data: true,
      max_rows: 50,
      providers: [
        {
          id: "primary",
          kind: "deepseek",
          api_key: "documentation-test-key",
          models: ["deepseek-chat"],
        },
      ],
      default_provider: "primary",
      default_model: "deepseek-chat",
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto("/instance-settings/assistant");
  await expect(page.getByLabel("Allowed models", { exact: true })).toHaveValue(
    "deepseek-chat",
  );
  await capture(
    page,
    "assistant-settings",
    page.locator(".settings-card"),
    ".assistant-launcher { visibility: hidden !important; }",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await example(page);
  await node(page, "Paid orders").click();
  await page
    .getByRole("button", { name: "Open AI assistant", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "AI assistant" }),
  ).toBeVisible();
  await capture(page, "assistant-chat");
});
