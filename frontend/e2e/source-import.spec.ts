import { execFileSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import { autosaved, signIn } from "./helpers";
import type { Snapshot } from "../src/types";

async function drop(page: Page, files: { name: string; content: string }[]) {
  const dataTransfer = await page.evaluateHandle((items) => {
    const data = new DataTransfer();
    items.forEach((file) =>
      data.items.add(new File([file.content], file.name)),
    );
    return data;
  }, files);
  const canvas = page.locator(".react-flow");
  const bounds = (await canvas.boundingBox())!;
  await canvas.dispatchEvent("drop", {
    dataTransfer,
    clientX: bounds.x + 400,
    clientY: bounds.y + 220,
  });
  await dataTransfer.dispose();
}

test("drop CSV and JSON, preview before a run, edit types and reuse a project file", async ({
  page,
}) => {
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "Source imports" },
    })
  ).json();
  const endpoint = `/api/worktrees/${worktree.id}`;
  const snapshot = async (): Promise<Snapshot> =>
    (await page.request.get(endpoint)).json();
  try {
    await page.goto(`/worktrees/${worktree.id}/flow`);
    await drop(page, [
      { name: "customers.csv", content: "id;name\n001;Alice\n002;Bob\n" },
      { name: "events.json", content: '[{"event":"signup","count":2}]' },
      { name: "notes.txt", content: "not a source" },
    ]);
    // Supported files are imported; the others are named.
    await expect(
      page.getByText("notes.txt: choose CSV, Parquet, XLSX or JSON files."),
    ).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(2);
    const inspector = page.locator(".inspector");
    await expect(inspector.locator(".source-sample")).toContainText("Alice");
    await expect(
      inspector
        .getByRole("combobox", { name: /^file/ })
        .locator("option:checked"),
    ).toHaveText("customers.csv");
    await expect(
      inspector.getByRole("textbox", { name: /delimiter/ }),
    ).toHaveValue(";");
    let current = await snapshot();
    const source = current.bundle!.flow.nodes.find(
      (node) => node.label === "customers.csv",
    )!;
    expect(source.params).toMatchObject({ delimiter: ";", header: true });
    expect(source.params.file).not.toMatch(/^\//);
    expect(current.bundle!.flow.nodes[1].preset).toBe("load_json");
    const status = await (
      await page.request.get(`${endpoint}/status?environment=dev`)
    ).json();
    expect(status.active).toBeNull();
    expect(Object.keys(status.nodes)).toHaveLength(0);
    await autosaved(page, () =>
      inspector
        .getByRole("combobox", { name: "Data type: id", exact: true })
        .selectOption("VARCHAR"),
    );
    await expect(inspector.locator(".source-sample")).toContainText("001");
    // A failed override keeps every detected column listed, so it can be undone.
    const nameType = inspector.getByRole("combobox", {
      name: "Data type: name",
      exact: true,
    });
    await nameType.selectOption("BIGINT");
    await expect(inspector.getByRole("alert")).toContainText("customers.csv");
    await expect(
      inspector.getByRole("combobox", { name: "Data type: id", exact: true }),
    ).toHaveValue("VARCHAR");
    await autosaved(page, () => nameType.selectOption(""));
    await expect(inspector.locator(".source-sample")).toContainText("001");
    const response = await page.request.post(`${endpoint}/runs`, {
      data: { environment: "dev" },
    });
    expect(response.ok()).toBeTruthy();
    const run = await response.json();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
      )
      .toBe("success");
    await page.getByRole("button", { name: "Load CSV", exact: true }).click();
    const file = inspector.getByRole("combobox", { name: /^file/ });
    await expect(file).toHaveValue("");
    await expect(inspector).toContainText("drop files onto the canvas");
    await file.selectOption(String(source.params.file));
    await expect(inspector.locator(".source-sample")).toContainText("Alice");
    await expect
      .poll(
        async () => (await snapshot()).bundle!.flow.nodes[2].params.delimiter,
      )
      .toBe(";");
    current = await snapshot();
    expect(current.bundle!.flow.nodes[2].label).toBe("customers.csv");
    // Another delimiter changes the columns, so their type overrides are dropped.
    await autosaved(page, () =>
      inspector
        .getByRole("combobox", { name: "Data type: id", exact: true })
        .selectOption("VARCHAR"),
    );
    await autosaved(page, () =>
      inspector.getByRole("textbox", { name: /delimiter/ }).fill(","),
    );
    await expect
      .poll(async () => (await snapshot()).bundle!.flow.nodes[2].params.types)
      .toEqual({});
    await page.reload();
    await expect(page.locator(".react-flow__node")).toHaveCount(3);
  } finally {
    await page.request.delete(`/api/projects/${worktree.project}`);
  }
});

test("Load table gives an administrator a route to create and authorize a connection", async ({
  page,
}, testInfo) => {
  await signIn(page);
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "Empty sources" },
    })
  ).json();
  const database = testInfo.outputPath("source.duckdb");
  execFileSync("../.venv/bin/python", [
    "-c",
    "import duckdb,sys; db=duckdb.connect(sys.argv[1]); db.execute('CREATE TABLE customers AS SELECT 1 AS id'); db.close()",
    database,
  ]);
  const connector = "source_return_connector";
  const identity = "source_return_connection";
  await page.request.put("/api/catalog/connector", {
    data: {
      id: connector,
      name: "Source database",
      family: "database",
      parameters: [{ name: "database", type: "text" }],
      capabilities: ["read"],
      init_sql: "ATTACH {{ database }} AS {{ alias }} (READ_ONLY);",
    },
  });
  try {
    await page.goto(`/worktrees/${worktree.id}/flow`);
    await page.getByRole("button", { name: "Load table", exact: true }).click();
    const inspector = page.locator(".inspector");
    await expect(inspector).toContainText(
      "No database connection is authorized",
    );
    await inspector
      .getByRole("link", { name: "Create a connection", exact: true })
      .click();
    await expect(page).toHaveURL(/instance-settings\/connections\?project=/);
    await expect(
      page.getByText("The connection you create here will be authorized"),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "New connection", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("ID", { exact: true }).fill(identity);
    await dialog.getByLabel("Name", { exact: true }).fill("Source connection");
    await dialog
      .getByRole("combobox", { name: "Connector", exact: true })
      .selectOption(connector);
    await dialog.getByLabel("database", { exact: true }).fill(database);
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/worktrees/${worktree.id}/flow`));
    await expect(inspector).toBeVisible();
    await inspector
      .getByRole("combobox", { name: "connection", exact: true })
      .selectOption(identity);
    await inspector
      .getByRole("combobox", { name: "schema", exact: true })
      .selectOption("main");
    await inspector
      .getByRole("combobox", { name: "table", exact: true })
      .selectOption("customers");
    await expect(inspector.locator(".source-sample td")).toHaveText(["1"]);
  } finally {
    await page.request.delete(`/api/projects/${worktree.project}`);
    await page.request.delete(`/api/catalog/connection/${identity}`);
    await page.request.delete(`/api/catalog/connector/${connector}`);
  }
});

test("members without connections can find their project administrators", async ({
  page,
  browser,
}) => {
  await signIn(page);
  const username = `source-member-${Date.now()}`;
  const password = "source-member-password";
  const account = await (
    await page.request.post("/api/users", { data: { username, password } })
  ).json();
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "Member source" },
    })
  ).json();
  await page.request.put(
    `/api/projects/${worktree.project}/members/${account.id}`,
    { data: { role: "editor" } },
  );
  const context = await browser.newContext();
  const member = await context.newPage();
  try {
    await member.goto("/");
    await member.getByLabel("Username", { exact: true }).fill(username);
    await member.getByLabel("Password", { exact: true }).fill(password);
    await member.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      member.getByRole("navigation", { name: "Workspace", exact: true }),
    ).toBeVisible();
    await member.goto(`/worktrees/${worktree.id}/flow`);
    await member
      .getByRole("button", { name: "Load table", exact: true })
      .click();
    const inspector = member.locator(".inspector");
    await expect(
      inspector.getByRole("link", { name: "Create a connection", exact: true }),
    ).toHaveCount(0);
    await inspector
      .getByRole("link", { name: "Ask an administrator", exact: true })
      .click();
    await expect(member).toHaveURL(
      new RegExp(`/projects/${worktree.project}/settings/participants`),
    );
    await expect(
      member.getByRole("row").filter({ hasText: "admin" }).first(),
    ).toBeVisible();
  } finally {
    await context.close();
    await page.request.delete(`/api/projects/${worktree.project}`);
    await page.request.patch(`/api/users/${account.id}`, {
      data: { active: false },
    });
  }
});
