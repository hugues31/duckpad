import { expect, test } from "@playwright/test";
import { openInstanceSettings, signIn } from "./helpers";

test("connection IDs stay fixed and duplicate creation preserves the original", async ({
  page,
}) => {
  await signIn(page);
  await openInstanceSettings(page, "Connections");
  const dialog = page.getByRole("dialog");
  const save = dialog.getByRole("button", {
    name: "Save changes",
    exact: true,
  });
  const newConnection = page.getByRole("button", {
    name: "New connection",
    exact: true,
  });
  const identity = "warehouse_ui";
  try {
    await newConnection.click();
    await expect(dialog.getByLabel("ID", { exact: true })).toBeEnabled();
    await dialog.getByLabel("ID", { exact: true }).fill(identity);
    await dialog.getByLabel("Name", { exact: true }).fill("Warehouse UI");
    await dialog
      .getByRole("combobox", { name: "Connector", exact: true })
      .selectOption("oracle");
    await dialog
      .getByLabel("password", { exact: true })
      .fill("dev-test-secret");
    await dialog.getByRole("button", { name: "prod", exact: true }).click();
    await dialog
      .getByLabel("password", { exact: true })
      .fill("prod-test-secret");
    await save.click();
    await expect(dialog).toHaveCount(0);

    await page
      .locator(".connection-card")
      .filter({ hasText: "Warehouse UI" })
      .click();
    await expect(dialog.getByLabel("ID", { exact: true })).toBeDisabled();
    await expect(dialog.getByLabel("ID", { exact: true })).toHaveValue(
      identity,
    );
    await dialog.getByLabel("Name", { exact: true }).fill("Renamed warehouse");
    await save.click();
    await expect(dialog).toHaveCount(0);
    const original = await (await page.request.get("/api/catalog")).json();

    await newConnection.click();
    await dialog.getByLabel("ID", { exact: true }).fill(identity);
    await dialog
      .getByLabel("Name", { exact: true })
      .fill("Accidental replacement");
    const rejected = page.waitForResponse((response) =>
      response.url().includes("/api/catalog/connection?create=true"),
    );
    await save.click();
    expect((await rejected).status()).toBe(409);
    await expect(dialog.getByRole("alert")).toHaveText(
      "A connection with this identifier already exists. Choose another identifier.",
    );
    expect(await (await page.request.get("/api/catalog")).json()).toEqual(
      original,
    );

    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await newConnection.click();
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    await expect(dialog.getByLabel("ID", { exact: true })).toHaveValue("");
    await expect(dialog.getByLabel("ID", { exact: true })).toBeEnabled();
  } finally {
    await page.request.delete(`/api/catalog/connection/${identity}`);
  }
});

test("switching connectors removes obsolete values across all environments", async ({
  page,
}) => {
  await signIn(page);
  const identity = "switch_connector_ui";
  // A second connector declaring root keeps the values entered for Server folder.
  const folder = (
    await (await page.request.get("/api/catalog")).json()
  ).connectors.find((c: { id: string }) => c.id === "folder");
  expect(
    (
      await page.request.put("/api/catalog/connector", {
        data: { ...folder, id: "archive_ui", name: "Archive UI" },
      })
    ).ok(),
  ).toBeTruthy();
  const created = await page.request.put(
    "/api/catalog/connection?create=true",
    {
      data: {
        id: identity,
        name: "Switch connector UI",
        connector: "oracle",
        environments: {
          dev: {
            user: "dev-reader",
            password: "dev-test-secret",
            dsn: "dev-db",
          },
          prod: {
            user: "prod-reader",
            password: "prod-test-secret",
            dsn: "prod-db",
          },
        },
      },
    },
  );
  expect(created.ok()).toBeTruthy();
  try {
    await page.reload();
    await openInstanceSettings(page, "Connections");
    await page
      .locator(".connection-card")
      .filter({ hasText: "Switch connector UI" })
      .click();
    const dialog = page.getByRole("dialog");
    const connector = dialog.getByRole("combobox", {
      name: "Connector",
      exact: true,
    });
    await connector.selectOption("folder");
    await connector.selectOption("oracle");
    for (const env of ["dev", "prod"]) {
      await dialog.getByRole("button", { name: env, exact: true }).click();
      await expect(dialog.getByLabel("password", { exact: true })).toHaveValue(
        "",
      );
      await expect(dialog.getByLabel("user", { exact: true })).toHaveValue("");
    }
    await connector.selectOption("folder");
    for (const env of ["dev", "prod"]) {
      await dialog.getByRole("button", { name: env, exact: true }).click();
      await dialog.getByLabel("root", { exact: true }).fill(`data/${env}`);
    }
    await connector.selectOption("archive_ui");
    await expect(dialog.getByLabel("root", { exact: true })).toHaveValue(
      "data/prod",
    );
    const saved = page.waitForResponse((response) =>
      response.url().includes("/api/catalog/connection?create=false"),
    );
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    const response = await saved;
    expect(response.ok()).toBeTruthy();
    const expected = { dev: { root: "data/dev" }, prod: { root: "data/prod" } };
    expect(response.request().postDataJSON().environments).toEqual(expected);
    const catalog = await response.json();
    expect(
      catalog.connections.find((c: { id: string }) => c.id === identity),
    ).toMatchObject({
      connector: "archive_ui",
      environments: expected,
    });
    await expect(dialog).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/catalog/connection/${identity}`);
    await page.request.delete("/api/catalog/connector/archive_ui");
  }
});

test("saving a deleted connection reports the missing record without recreating it", async ({
  page,
}) => {
  await signIn(page);
  const identity = "deleted_connection_ui";
  const created = await page.request.put(
    "/api/catalog/connection?create=true",
    {
      data: {
        id: identity,
        name: "Deleted connection UI",
        connector: "folder",
        environments: { dev: {} },
      },
    },
  );
  expect(created.ok()).toBeTruthy();
  try {
    await page.reload();
    await openInstanceSettings(page, "Connections");
    await page
      .locator(".connection-card")
      .filter({ hasText: "Deleted connection UI" })
      .click();
    await page.request.delete(`/api/catalog/connection/${identity}`);
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "This connection no longer exists. Close this form and create a new connection.",
    );
    const catalog = await (await page.request.get("/api/catalog")).json();
    expect(
      catalog.connections.some((c: { id: string }) => c.id === identity),
    ).toBe(false);
  } finally {
    await page.request.delete(`/api/catalog/connection/${identity}`);
  }
});

test("connector definitions are grouped by family, customized built-ins reset and duplicates are new types", async ({
  page,
}) => {
  await signIn(page);
  const listed = (await (await page.request.get("/api/catalog")).json())
    .connectors as { id: string; origin: string }[];
  const { origin: _, ...s3 } = listed.find((c) => c.id === "s3")!;
  const landing = {
    id: "landing_ui",
    name: "Landing UI",
    family: "storage",
    parameters: [{ name: "root", type: "text" }],
    capabilities: ["read"],
    init_sql: "",
  };
  try {
    for (const data of [{ ...s3, name: "Company S3" }, landing])
      expect(
        (await page.request.put("/api/catalog/connector", { data })).ok(),
      ).toBeTruthy();
    await page.reload();
    await openInstanceSettings(page, "Connections");
    const family = (name: string) =>
      page
        .locator(".connector-family")
        .filter({ has: page.getByRole("heading", { name, exact: true }) })
        .locator(".connector-row");
    const storage = family("File storage");
    await expect(
      family("Databases and warehouses").filter({ hasText: "Oracle" }),
    ).toContainText("Built-in");
    await expect(storage.filter({ hasText: "Server folder" })).toContainText(
      "Built-in",
    );
    await expect(storage.filter({ hasText: "Company S3" })).toContainText(
      "Customized",
    );
    // An administrator's own storage type is grouped like the built-ins.
    const custom = storage.filter({ hasText: "Landing UI" });
    await expect(custom).toBeVisible();
    await expect(custom.locator(".badge")).toHaveText(["Read"]);

    await storage
      .getByRole("button", { name: "Duplicate Server folder", exact: true })
      .click();
    const editor = page.getByRole("dialog");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(editor).toHaveCount(0);
    // The copy is listed at the end of its family, so saving confirms it.
    await expect(page.locator(".toast")).toContainText(
      "Connector definition Server folder (copy) created",
    );
    await expect(
      storage.filter({ hasText: "Server folder (copy)" }),
    ).not.toContainText("Built-in");
    // Editing a definition under an identifier already taken never replaces it.
    await storage
      .getByRole("button", { name: "Edit Landing UI", exact: true })
      .click();
    await editor.locator(".monaco-editor").getByText("landing_ui").dblclick();
    await page.keyboard.insertText("folder_copy");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(editor.locator(".notice.error")).toHaveText(
      "A connector with this identifier already exists. Choose another identifier.",
    );
    await editor
      .locator("footer")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(
      storage.filter({ hasText: "Server folder (copy)" }),
    ).toHaveCount(1);
    // A second duplicate keeps the identifier of the first and is refused.
    await storage
      .getByRole("button", { name: "Duplicate Server folder", exact: true })
      .click();
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(editor.locator(".notice.error")).toHaveText(
      "A connector with this identifier already exists. Choose another identifier.",
    );
    await editor
      .locator("footer")
      .getByRole("button", { name: "Close", exact: true })
      .click();

    await storage
      .getByRole("button", { name: "Reset to built-in Company S3" })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Reset to built-in", exact: true })
      .click();
    await expect(storage.filter({ hasText: "Amazon S3" })).toContainText(
      "Built-in",
    );
    await expect(
      storage.getByRole("button", { name: /^Reset to built-in/ }),
    ).toHaveCount(0);
  } finally {
    await page.request.post("/api/catalog/connector/s3/reset");
    await page.request.delete("/api/catalog/connector/landing_ui");
    await page.request.delete("/api/catalog/connector/folder_copy");
  }
});

test("file nodes offer granted storage connections as locations, custom types included", async ({
  page,
}) => {
  await signIn(page);
  const connector = {
    id: "landing_location_ui",
    name: "Landing bucket",
    family: "storage",
    parameters: [{ name: "root", type: "text" }],
    capabilities: ["read", "write"],
    init_sql: "",
  };
  const connections = [
    { id: "landing_ui", name: "Landing", connector: connector.id },
    { id: "finance_ui", name: "Finance share", connector: "folder" },
    { id: "warehouse_location_ui", name: "Warehouse", connector: "oracle" },
  ];
  const worktree = await (
    await page.request.post("/api/projects", { data: { name: "Locations" } })
  ).json();
  try {
    expect(
      (
        await page.request.put("/api/catalog/connector", { data: connector })
      ).ok(),
    ).toBeTruthy();
    for (const { id, name, connector } of connections)
      expect(
        (
          await page.request.put("/api/catalog/connection?create=true", {
            data: {
              id,
              name,
              connector,
              environments: { dev: { root: "gs://landing/raw/" } },
            },
          })
        ).ok(),
      ).toBeTruthy();
    expect(
      (
        await page.request.put(
          `/api/projects/${worktree.project}/connections`,
          { data: { connections: connections.map((c) => c.id) } },
        )
      ).ok(),
    ).toBeTruthy();
    await page.goto(`/worktrees/${worktree.id}/flow`);
    await page.getByRole("button", { name: "Load XLSX", exact: true }).click();
    const location = page
      .locator(".inspector")
      .getByRole("combobox", { name: "Location", exact: true });
    await expect(location.locator("option")).toHaveText([
      "Project files",
      "Landing",
      "Finance share",
    ]);
  } finally {
    await page.request.delete(`/api/projects/${worktree.project}`);
    for (const { id } of connections)
      await page.request.delete(`/api/catalog/connection/${id}`);
    await page.request.delete(`/api/catalog/connector/${connector.id}`);
  }
});
