import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import { verifyPaletteDetails } from "./palette-details-flow";
import fr from "../src/locales/fr.json" with { type: "json" };
import pt from "../src/locales/pt.json" with { type: "json" };

test("palette clicks inspect current definitions without writes; drops create nodes", async ({
  page,
}) => {
  await signIn(page);
  await verifyPaletteDetails(page);
});

test("palette details remain readable and dismissible on a phone in French and Portuguese", async ({
  page,
}) => {
  await signIn(page);
  const response = await page.request.post("/api/projects", {
    data: { name: "Mobile palette" },
  });
  const { id } = await response.json();
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [language, labels] of Object.entries({ fr, pt })) {
    await page.evaluate((language) => {
      localStorage.setItem("duckpad-language", language);
      localStorage.setItem("duckpad-theme", "dark");
    }, language);
    await page.goto(`/worktrees/${id}/flow`);
    await page
      .getByRole("button", { name: labels.toggleNodes, exact: true })
      .click();
    await page
      .locator(".palette-list")
      .getByRole("button", { name: labels.load_csv, exact: true })
      .click();
    const details = page.getByRole("complementary", {
      name: labels.nodeTypeDetails,
      exact: true,
    });
    await expect(details).toBeVisible();
    await expect(details).toContainText(labels.noNodeInputs);
    const bounds = (await details.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(391);
    await details
      .getByRole("button", { name: labels.close, exact: true })
      .click();
    await expect(page.locator(".palette")).toBeVisible();
    await expect(page.locator(".react-flow__node")).toHaveCount(0);
  }
});
