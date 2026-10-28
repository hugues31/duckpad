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
          name: labels[scenario.language === "fr" ? "french" : "english"],
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
