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
    await connector.selectOption("local");
    await connector.selectOption("oracle");
    for (const env of ["dev", "prod"]) {
      await dialog.getByRole("button", { name: env, exact: true }).click();
      await expect(dialog.getByLabel("password", { exact: true })).toHaveValue(
        "",
      );
      await expect(dialog.getByLabel("user", { exact: true })).toHaveValue("");
    }
    await connector.selectOption("local");
    for (const env of ["dev", "prod"]) {
      await dialog.getByRole("button", { name: env, exact: true }).click();
      await dialog.getByLabel("root", { exact: true }).fill(`data/${env}`);
    }
    await connector.selectOption("xlsx");
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
      connector: "xlsx",
      environments: expected,
    });
    await expect(dialog).toHaveCount(0);
  } finally {
    await page.request.delete(`/api/catalog/connection/${identity}`);
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
        connector: "local",
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
