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

test("the drifting sign-in logo glides under the pointer instead of jumping", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const mark = page.locator(".login-brand .duck-mark");
  // How far the gradient has moved: 0 at rest, 100 once hovered.
  const glide = () =>
    mark.evaluate((element) =>
      parseFloat(getComputedStyle(element).backgroundPosition),
    );
  // Hold the newest transition halfway, then let it end.
  const transition = (step: "halfway" | "finish") =>
    mark.evaluate((element, step) => {
      const hover = element
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .at(-1);
      if (step === "finish") return hover?.finish();
      hover?.pause();
      if (hover) hover.currentTime = 300;
    }, step);

  // Stop the drift a quarter of the way through, and hold every hover
  // transition as it starts: the test steps through them at its own pace.
  await mark.evaluate((element) => {
    const [drift] = element.getAnimations();
    drift.pause();
    drift.currentTime = 1500;
    element.addEventListener("transitionrun", () => {
      for (const animation of element.getAnimations()) animation.pause();
    });
  });
  const drifted = await glide();
  expect(drifted).toBeGreaterThan(0);
  expect(drifted).toBeLessThan(50);

  await mark.hover();
  await transition("halfway");
  const entering = await glide();
  expect(entering).toBeGreaterThan(drifted);
  expect(entering).toBeLessThan(100);
  await transition("finish");
  expect(await glide()).toBe(100);

  await page.mouse.move(0, 0);
  await transition("halfway");
  const leaving = await glide();
  expect(leaving).toBeGreaterThan(drifted);
  expect(leaving).toBeLessThan(100);
  await transition("finish");
  expect(await glide()).toBeCloseTo(drifted, 3);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await mark.hover();
  expect(await mark.evaluate((element) => element.getAnimations().length)).toBe(
    0,
  );
  expect(await glide()).toBe(0);
});
