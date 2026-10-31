import { expect, test } from "@playwright/test";
import en from "../src/locales/en.json" with { type: "json" };
import { openInstanceSettings, openUserSettings, signIn } from "./helpers";

test("create a personal token once, attribute a run and revoke it", async ({
  page,
}) => {
  await signIn(page);
  await openUserSettings(page);
  const section = page.getByRole("region", { name: en.apiTokens, exact: true });
  await section
    .getByLabel(en.apiTokenName, { exact: true })
    .fill("Browser automation");
  const expiry = section.getByLabel(en.apiTokenExpires, { exact: true });
  const suggested = new Date(await expiry.inputValue()).getTime() - Date.now();
  expect(suggested).toBeGreaterThan(89 * 86400000);
  expect(suggested).toBeLessThanOrEqual(90 * 86400000);
  await expiry.fill("");
  await section
    .getByRole("button", { name: en.createApiToken, exact: true })
    .click();
  const secret = section.getByLabel(en.apiTokenSecret, { exact: true });
  await expect(secret).toHaveValue(/^dpk_/);
  const token = await secret.inputValue();
  const headers = { Authorization: `Bearer ${token}`, Cookie: "" };
  expect((await page.request.get("/api/session", { headers })).ok()).toBe(true);
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "Token history" },
    })
  ).json();
  const run = await (
    await page.request.post(`/api/worktrees/${worktree.id}/runs`, {
      headers,
      data: { environment: "dev" },
    })
  ).json();
  await page.goto(`/worktrees/${worktree.id}/history`);
  await page.locator(".history-row").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(`${en.runRequester}: admin`);
  await expect(dialog).toContainText("Browser automation");
  await expect(dialog).toContainText(run.id);
  await page.goto("/user-settings");
  await expect(secret).toHaveCount(0);
  const row = section
    .getByRole("row")
    .filter({ hasText: "Browser automation" });
  await expect(row).toContainText(en.apiTokenNoExpiry);
  await row
    .getByRole("button", { name: en.revokeApiToken, exact: true })
    .click();
  await row.getByRole("button", { name: en.confirm, exact: true }).click();
  await expect(row).toHaveCount(0);
  expect((await page.request.get("/api/session", { headers })).status()).toBe(
    401,
  );
});

test("create a service account and restrict project access to Reader", async ({
  page,
}) => {
  await signIn(page);
  await openInstanceSettings(page);
  const name = `service-${Date.now()}`;
  await page
    .getByRole("button", { name: en.addServiceAccount, exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(en.username, { exact: true }).fill(name);
  await dialog
    .getByLabel(en.serviceDescription, { exact: true })
    .fill("Nightly reporting");
  await expect(dialog.getByLabel(en.newPassword, { exact: true })).toHaveCount(
    0,
  );
  await dialog.getByRole("button", { name: en.create, exact: true }).click();
  const account = page.getByRole("row").filter({ hasText: name });
  await expect(account).toContainText(en.serviceAccount);
  await expect(account.getByRole("combobox")).toBeDisabled();
  await expect(
    account.getByRole("button", { name: en.resetPassword }),
  ).toBeDisabled();
  await account
    .getByRole("button", { name: en.apiTokens, exact: true })
    .click();
  await expect(dialog).toContainText("Nightly reporting");
  await dialog
    .getByLabel(en.apiTokenName, { exact: true })
    .fill("Service automation");
  await dialog
    .getByRole("button", { name: en.createApiToken, exact: true })
    .click();
  const secret = dialog.getByLabel(en.apiTokenSecret, { exact: true });
  await expect(secret).toHaveValue(/^dpk_/);
  const token = await secret.inputValue();
  const headers = { Authorization: `Bearer ${token}`, Cookie: "" };
  const user = await (
    await page.request.get("/api/session", { headers })
  ).json();
  expect(user.username).toBe(name);
  expect(
    (
      await page.request.post("/api/login", {
        data: { username: name, password: "not-a-service-password" },
      })
    ).status(),
  ).toBe(401);
  const worktree = await (
    await page.request.post("/api/projects", {
      data: { name: "Service membership" },
    })
  ).json();
  await page.goto(`/projects/${worktree.project}/settings`);
  await page.getByLabel(en.user, { exact: true }).selectOption(user.id);
  const role = page.getByLabel(en.projectRole, { exact: true });
  await expect(role.locator("option")).toHaveCount(1);
  await expect(role).toHaveValue("reader");
  await page
    .getByRole("button", { name: en.addParticipant, exact: true })
    .click();
  const member = page.getByRole("row").filter({ hasText: name });
  await expect(member.getByRole("combobox")).toBeDisabled();
  expect(
    (await page.request.get(`/api/worktrees/${worktree.id}`, { headers })).ok(),
  ).toBe(true);
  expect(
    (
      await page.request.post(`/api/worktrees/${worktree.id}/runs`, {
        headers,
        data: { environment: "dev" },
      })
    ).status(),
  ).toBe(403);
  await page.goto("/instance-settings/users");
  await account
    .getByRole("button", { name: en.apiTokens, exact: true })
    .click();
  await expect(secret).toHaveCount(0);
  const row = dialog.getByRole("row").filter({ hasText: "Service automation" });
  await row
    .getByRole("button", { name: en.revokeApiToken, exact: true })
    .click();
  await row.getByRole("button", { name: en.confirm, exact: true }).click();
  await expect(row).toHaveCount(0);
  expect((await page.request.get("/api/session", { headers })).status()).toBe(
    401,
  );
});
