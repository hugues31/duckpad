import { expect, test, type Page } from "@playwright/test";
import en from "../src/locales/en.json" with { type: "json" };
import { openInstanceSettings, openUserSettings, signIn } from "./helpers";

/** Create a connection that no project is granted yet. */
async function createConnection(page: Page, id: string, name: string) {
  for (const [kind, data] of [
    [
      "connector",
      {
        id,
        name,
        parameters: [{ name: "root", type: "text", default: "" }],
        capabilities: ["read"],
        init_sql: "",
      },
    ],
    [
      "connection?create=true",
      {
        id,
        name,
        connector: id,
        environments: { dev: { root: "" }, prod: { root: "" } },
      },
    ],
  ] as const)
    expect(
      (await page.request.put(`/api/catalog/${kind}`, { data })).ok(),
    ).toBe(true);
}

async function grantedConnections(page: Page, project: string) {
  const response = await page.request.get(`/api/projects/${project}/settings`);
  return ((await response.json()).connections as string[]).sort();
}

test("user administration reports errors in the dialog or table that caused them", async ({
  page,
}) => {
  await signIn(page);
  await openInstanceSettings(page);
  const username = `administration-${Date.now()}`;
  const dialog = page.getByRole("dialog");
  await page.getByRole("button", { name: en.addUser, exact: true }).click();
  await dialog.getByLabel(en.username, { exact: true }).fill("admin");
  await dialog
    .getByLabel(en.newPassword, { exact: true })
    .fill("administration-password");
  await dialog.getByRole("button", { name: en.create, exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Username already exists");
  await dialog.getByLabel(en.username, { exact: true }).fill(username);
  await dialog.getByRole("button", { name: en.create, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const row = page.getByRole("row").filter({ hasText: username });
  await expect(row).toContainText(en.accountActive);
  await expect(page.getByRole("alert")).toHaveCount(0);

  const search = page.getByLabel(en.searchUsers, { exact: true });
  await search.fill(`${username}-missing`);
  await expect(page.getByText(en.noUsers, { exact: true })).toBeVisible();
  await search.fill(username);
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(page.getByText(en.noUsers, { exact: true })).toHaveCount(0);

  await page.route("**/api/users/*", (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({ status: 409, json: { error: "Rejected change" } })
      : route.continue(),
  );
  await row
    .getByRole("button", { name: en.resetPassword, exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await dialog
    .getByLabel(en.newPassword, { exact: true })
    .fill("administration-reset-password");
  await dialog.getByRole("button", { name: en.save, exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Rejected change");
  await expect(page.getByRole("alert")).toHaveCount(1);
  await dialog.getByRole("button", { name: en.cancel, exact: true }).click();
  const role = page.getByLabel(`${en.instanceRole} · ${username}`, {
    exact: true,
  });
  await role.selectOption("admin");
  await expect(page.getByRole("alert")).toHaveText("Rejected change");
  await expect(role).toHaveValue("member");
  await page.unroute("**/api/users/*");

  await row.getByRole("button", { name: en.deactivate, exact: true }).click();
  await dialog
    .getByRole("button", { name: en.deactivate, exact: true })
    .click();
  await expect(row).toContainText(en.accountInactive);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await row.getByRole("button", { name: en.reactivate, exact: true }).click();
  await expect(row).toContainText(en.accountActive);
  await row.getByRole("button", { name: en.deactivate, exact: true }).click();
  await dialog
    .getByRole("button", { name: en.deactivate, exact: true })
    .click();
  await expect(row).toContainText(en.accountInactive);
});

test("project settings keep unsaved connection grants until they are saved or discarded", async ({
  page,
}) => {
  await signIn(page);
  const suffix = Date.now();
  const connection = `grant_${suffix}`;
  const connectionName = `Granted files ${suffix}`;
  await createConnection(page, connection, connectionName);
  const username = `grants-${suffix}`;
  const user = await (
    await page.request.post("/api/users", {
      data: { username, password: "grants-browser-password", role: "member" },
    })
  ).json();
  const created = await page.request.post("/api/projects", {
    data: { name: `Grants ${suffix}` },
  });
  expect(created.ok()).toBe(true);
  const { project } = await created.json();
  await page.goto(`/projects/${project}/settings`);
  const grant = page.getByRole("checkbox", {
    name: connectionName,
    exact: true,
  });
  const save = page.getByRole("button", {
    name: en.saveConnections,
    exact: true,
  });
  const unsaved = page.getByText(en.unsavedChanges, { exact: true });
  await expect(grant).not.toBeChecked();
  await expect(save).toBeDisabled();
  await grant.check();
  await expect(save).toBeEnabled();
  await expect(unsaved).toBeVisible();

  // Other changes reload the settings without resetting the selection.
  await page.getByLabel(en.user, { exact: true }).selectOption(user.id);
  await page
    .getByRole("button", { name: en.addParticipant, exact: true })
    .click();
  const role = page.getByLabel(`${en.projectRole} · ${username}`, {
    exact: true,
  });
  await expect(role).toHaveValue("reader");
  await expect(grant).toBeChecked();
  await role.selectOption("editor");
  await expect(role).toHaveValue("editor");
  await expect(grant).toBeChecked();
  expect(await grantedConnections(page, project)).toEqual(["local"]);

  // A rejected save keeps the selection to retry.
  await page.route(`**/api/projects/${project}/connections`, (route) =>
    route.fulfill({ status: 409, json: { error: "Rejected grants" } }),
  );
  await save.click();
  await expect(page.getByRole("alert")).toHaveText("Rejected grants");
  await expect(grant).toBeChecked();
  await expect(unsaved).toBeVisible();
  await page.unroute(`**/api/projects/${project}/connections`);

  // Leaving the page asks before discarding the selection.
  const backToProjects = page.getByRole("link", {
    name: en.backToProjects,
    exact: true,
  });
  const confirmation = page.getByRole("dialog");
  await backToProjects.click();
  await expect(confirmation).toContainText(en.leavePageHint);
  await confirmation
    .getByRole("button", { name: en.stayOnPage, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/projects/${project}/settings$`));
  await expect(grant).toBeChecked();

  await save.click();
  await expect(save).toBeDisabled();
  await expect(unsaved).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await grantedConnections(page, project)).toEqual(
    [connection, "local"].sort(),
  );
  // Selecting the saved grants again leaves nothing to save.
  await grant.uncheck();
  await expect(save).toBeEnabled();
  await grant.check();
  await expect(save).toBeDisabled();

  await grant.uncheck();
  await backToProjects.click();
  await confirmation
    .getByRole("button", { name: en.leavePage, exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects$/);
  await page.goto(`/projects/${project}/settings`);
  await expect(grant).toBeChecked();

  // Deleting the project drops its unsaved grants without asking.
  await grant.uncheck();
  await page
    .getByRole("button", { name: en.deleteProject, exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: en.confirm, exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(confirmation).toHaveCount(0);
  await page.request.patch(`/api/users/${user.id}`, {
    data: { active: false },
  });
});

test("a rejected password change is reported and keeps the session", async ({
  page,
}) => {
  await signIn(page);
  await openUserSettings(page);
  await page
    .getByLabel(en.currentPassword, { exact: true })
    .fill("not-the-current-password");
  await page
    .getByLabel(en.newPassword, { exact: true })
    .fill("unused-browser-password");
  await page
    .getByRole("button", { name: en.changePassword, exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "Current password is incorrect",
  );
  await expect(
    page.getByRole("heading", { name: en.userSettings, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: en.userSettings, exact: true }),
  ).toBeVisible();
});
