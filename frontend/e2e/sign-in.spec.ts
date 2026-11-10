import { expect, test } from "@playwright/test";
import en from "../src/locales/en.json" with { type: "json" };
import { PASSWORD, submitLogin } from "./helpers";

test.use({ locale: "en-US" });

test("the first-launch setup link chooses the password and signs in", async ({
  page,
}) => {
  const sent: unknown[] = [];
  // The disposable instance already replaced the generated password, which
  // revokes its setup link; answer with a real session instead.
  await page.route("**/api/setup", async (route) => {
    sent.push(route.request().postDataJSON());
    const session = await page.request.post("/api/login", {
      data: { username: "admin", password: PASSWORD },
    });
    await route.fulfill({ response: session });
  });
  await page.goto("/#setup=first-launch-token");
  await expect(
    page.getByRole("heading", { name: en.setupTitle, exact: true }),
  ).toBeVisible();
  // The token leaves the address bar and the history entry.
  await expect.poll(() => page.evaluate(() => location.hash)).toBe("");
  await expect(page.getByLabel(en.username, { exact: true })).toHaveValue(
    "admin",
  );
  await page
    .getByLabel(en.newPassword, { exact: true })
    .fill("a memorable password");
  await page
    .getByLabel(en.confirmPassword, { exact: true })
    .fill("another password");
  await page.getByRole("button", { name: en.setupAction, exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(en.passwordMismatch);
  expect(sent).toEqual([]);

  await page
    .getByLabel(en.confirmPassword, { exact: true })
    .fill("a memorable password");
  await page.getByRole("button", { name: en.setupAction, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: en.projects, exact: true }),
  ).toBeVisible();
  expect(sent).toEqual([
    { token: "first-launch-token", password: "a memorable password" },
  ]);
});

test("an expired setup link and a failed sign-in explain how to get back in", async ({
  page,
}) => {
  await page.goto("/#setup=expired-token");
  await page
    .getByLabel(en.newPassword, { exact: true })
    .fill("a memorable password");
  await page
    .getByLabel(en.confirmPassword, { exact: true })
    .fill("a memorable password");
  await page.getByRole("button", { name: en.setupAction, exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "This setup link no longer works",
  );
  await page
    .getByRole("button", { name: en.setupSignInInstead, exact: true })
    .click();

  const help = page.locator(".login-help");
  await expect(help).not.toHaveAttribute("open");
  await page
    .getByLabel(en.password, { exact: true })
    .fill("not the right password");
  await page
    .getByRole("button", { name: en.signInAction, exact: true })
    .click();
  await expect(page.locator(".notice.error")).toHaveText(
    "Invalid username or password",
  );
  await expect(help).toHaveAttribute("open");
  await expect(help.locator("code")).toHaveText("duckpad reset-password");
  await submitLogin(page);
});
