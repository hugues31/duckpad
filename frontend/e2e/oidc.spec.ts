import { test, expect, type Page } from "@playwright/test";
import { signIn } from "./helpers";

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Account menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
}

test("configure OIDC, sign in through a signing provider, administer access and disable SSO", async ({
  page,
  browser,
  baseURL,
}) => {
  await signIn(page);
  await openSettings(page);
  const settings = page.getByRole("region", { name: "Single sign-on (OIDC)" });
  await settings.getByLabel("Enable single sign-on", { exact: true }).check();
  await settings.getByLabel("Sign-in button label").fill("Test organization");
  await settings.getByLabel("Issuer URL").fill(baseURL + "/test-oidc");
  await settings.getByLabel("Client ID", { exact: true }).fill("test-client");
  await settings
    .getByLabel("Client secret", { exact: true })
    .fill("test-secret");
  await expect(
    settings.getByLabel("Redirect URI", { exact: true }),
  ).toHaveValue(baseURL + "/api/oidc/callback");
  await settings
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(settings.getByRole("status")).toContainText(
    "SSO settings saved",
  );
  await expect(
    settings.getByLabel("Client secret", { exact: true }),
  ).toHaveValue("");
  await page.reload();
  await openSettings(page);
  await expect(
    settings.getByLabel("Enable single sign-on", { exact: true }),
  ).toBeChecked();
  await expect(settings.getByLabel("Issuer URL")).toHaveValue(
    baseURL + "/test-oidc",
  );
  await expect(
    settings.getByLabel("Client secret", { exact: true }),
  ).toHaveValue("");

  const context = await browser.newContext({ baseURL });
  try {
    const member = await context.newPage();
    await member.goto("/");
    await member
      .getByRole("link", {
        name: "Continue with Test organization",
        exact: true,
      })
      .click();
    await expect(
      member.getByRole("heading", { name: "Test identity provider" }),
    ).toBeVisible();
    await member.getByRole("link", { name: "Approve test sign-in" }).click();
    await expect(
      member.getByRole("navigation", { name: "Workspace", exact: true }),
    ).toBeVisible();
    const user = await (await member.request.get("/api/session")).json();
    expect(user.role).toBe("member");
    expect(user.auth_method).toBe("oidc");
    expect(
      (await (await member.request.get("/api/workspace")).json()).projects,
    ).toEqual([]);
    await openSettings(member);
    await expect(
      member.getByRole("region", { name: "Single sign-on (OIDC)" }),
    ).toHaveCount(0);
    await expect(
      member.getByText("This account signs in through SSO.", { exact: false }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Users", exact: true }).click();
    const row = page.getByRole("row").filter({ hasText: user.username });
    await expect(row).toContainText("SSO");
    await expect(
      row.getByRole("button", { name: "Reset password", exact: true }),
    ).toBeDisabled();
    expect(
      (
        await page.request.patch(`/api/users/${user.id}`, {
          data: { active: false },
        })
      ).ok(),
    ).toBeTruthy();
    await member.reload();
    await expect(
      member.getByRole("link", {
        name: "Continue with Test organization",
        exact: true,
      }),
    ).toBeVisible();
    await member
      .getByRole("link", {
        name: "Continue with Test organization",
        exact: true,
      })
      .click();
    await member.getByRole("link", { name: "Approve test sign-in" }).click();
    await expect(member.getByRole("alert")).toContainText(
      "Single sign-on failed or expired",
    );
    expect(
      (
        await page.request.patch(`/api/users/${user.id}`, {
          data: { active: true },
        })
      ).ok(),
    ).toBeTruthy();
    await member
      .getByRole("link", {
        name: "Continue with Test organization",
        exact: true,
      })
      .click();
    await member.getByRole("link", { name: "Approve test sign-in" }).click();
    await expect(
      member.getByRole("navigation", { name: "Workspace", exact: true }),
    ).toBeVisible();
    expect((await (await member.request.get("/api/session")).json()).id).toBe(
      user.id,
    );

    await openSettings(page);
    await settings
      .getByLabel("Enable single sign-on", { exact: true })
      .uncheck();
    await settings
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect(settings.getByRole("status")).toContainText(
      "SSO settings saved",
    );
    await member.reload();
    await expect(
      member.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
    await expect(
      member.getByRole("link", {
        name: "Continue with Test organization",
        exact: true,
      }),
    ).toHaveCount(0);
    await signIn(member);
  } finally {
    await context.close();
    // Keep later browser scenarios independent even when an assertion fails.
    await page.request.put("/api/sso", { data: { enabled: false } });
  }
});
