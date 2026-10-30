import { test, expect } from "@playwright/test";
import en from "../src/locales/en.json" with { type: "json" };
import fr from "../src/locales/fr.json" with { type: "json" };
import { submitLogin } from "./helpers";

for (const scenario of [
  { locale: "fr-CA", colorScheme: "dark", language: "fr", theme: "dark" },
  { locale: "en-GB", colorScheme: "light", language: "en", theme: "light" },
  {
    locale: "de-DE",
    colorScheme: "no-preference",
    language: "en",
    theme: "light",
  },
] as const) {
  test.describe(`${scenario.locale} with ${scenario.colorScheme} appearance`, () => {
    test.use({ locale: scenario.locale, colorScheme: scenario.colorScheme });

    test("login and workspace use browser defaults without saving an override", async ({
      page,
    }) => {
      const labels = scenario.language === "fr" ? fr : en;
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute(
        "lang",
        scenario.language,
      );
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        scenario.theme,
      );
      await submitLogin(page, labels);
      await page.locator(".account .avatar").click();
      await expect(
        page.getByRole("menuitemradio", {
          name: scenario.language === "fr" ? "Français" : "English",
          exact: true,
        }),
      ).toHaveAttribute("aria-checked", "true");
      await expect(
        page.getByRole("menuitemradio", {
          name: labels[scenario.theme],
          exact: true,
        }),
      ).toHaveAttribute("aria-checked", "true");
      expect(
        await page.evaluate(() => [
          localStorage.getItem("duckpad-language"),
          localStorage.getItem("duckpad-theme"),
        ]),
      ).toEqual([null, null]);

      const nextTheme = scenario.theme === "dark" ? "light" : "dark";
      await page.emulateMedia({ colorScheme: nextTheme });
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        nextTheme,
      );
    });
  });
}

for (const scenario of [
  { languages: ["de-DE", "fr-CA", "en-US"], expected: "fr" },
  { languages: ["en-GB", "fr-FR"], expected: "en" },
  { languages: [], expected: "fr" },
]) {
  test(`uses ordered browser languages ${JSON.stringify(scenario.languages)} and ignores invalid saved values`, async ({
    page,
  }) => {
    await page.addInitScript((languages) => {
      Object.defineProperty(navigator, "languages", { value: languages });
      Object.defineProperty(navigator, "language", { value: "fr-FR" });
      localStorage.setItem("duckpad-language", "unsupported");
      localStorage.setItem("duckpad-theme", "unsupported");
    }, scenario.languages);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute(
      "lang",
      scenario.expected,
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const labels = scenario.expected === "fr" ? fr : en;
    await expect(
      page.getByRole("button", { name: labels.signInAction, exact: true }),
    ).toBeVisible();
  });
}

test.describe("manual preferences", () => {
  test.use({ locale: "fr-FR", colorScheme: "dark" });

  test("saved English and light choices override French and dark browser defaults", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTitle(fr.language, { exact: true }).click();
    await page.getByTitle(en.light, { exact: true }).click();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await expect(
      page.getByRole("button", { name: en.signInAction, exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => [
        localStorage.getItem("duckpad-language"),
        localStorage.getItem("duckpad-theme"),
      ]),
    ).toEqual(["en", "light"]);
    await submitLogin(page, en);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});

test.describe("preference controls", () => {
  test.use({ locale: "en-US", colorScheme: "light" });

  test("the account menu, user settings and login page offer every translated language", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByTitle(en.language, { exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await page.getByTitle(fr.language, { exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await submitLogin(page, en);

    await page
      .getByRole("button", { name: en.accountMenu, exact: true })
      .click();
    const menu = page.getByRole("menu");
    const options = (labels: typeof en, group: "language" | "theme") =>
      menu
        .getByRole("group", { name: labels[group], exact: true })
        .getByRole("menuitemradio");
    await expect(options(en, "language")).toHaveText(["English", "French"]);
    await expect(options(en, "theme")).toHaveText([en.light, en.dark]);
    await menu
      .getByRole("menuitemradio", { name: "French", exact: true })
      .click();
    await page
      .getByRole("button", { name: fr.accountMenu, exact: true })
      .click();
    await expect(options(fr, "language")).toHaveText(["Anglais", "Français"]);
    await expect(options(fr, "theme")).toHaveText([fr.light, fr.dark]);
    await menu
      .getByRole("menuitem", { name: fr.userSettings, exact: true })
      .click();

    const language = page.getByLabel(fr.language, { exact: true });
    const theme = page.getByLabel(fr.theme, { exact: true });
    await expect(language.locator("option")).toHaveText([
      "Anglais",
      "Français",
    ]);
    await expect(language).toHaveValue("fr");
    await expect(theme.locator("option")).toHaveText([fr.light, fr.dark]);
    await theme.selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await language.selectOption("en");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(
      page.getByLabel(en.language, { exact: true }).locator("option"),
    ).toHaveText(["English", "French"]);
  });
});
