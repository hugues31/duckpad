import { expect, test } from "@playwright/test";
import { openInstanceSettings, signIn } from "./helpers";
import { verifyAssistantRuns } from "./assistant-runs-flow";

test.afterEach(async ({ page }) => {
  await page.request.put("/api/assistant/settings", {
    data: { enabled: false, providers: [] },
  });
  await page.request.put("/api/environments/dev", {
    data: { label: "Development", color: "#3b82f6", confirm_before_run: false },
  });
});

test("approve a run after reloading, decline another and ask about a real error", async ({
  page,
}) => {
  test.setTimeout(180000);
  await signIn(page);
  expect(
    (
      await page.request.put("/api/assistant/settings", {
        data: {
          enabled: true,
          providers: [
            {
              id: "primary",
              kind: "deepseek",
              api_key: "browser-test-key",
              models: ["test"],
            },
          ],
          default_provider: "primary",
          default_model: "test",
        },
      })
    ).ok(),
  ).toBeTruthy();
  await verifyAssistantRuns(page);
});

test("administrators customize, reorder and restore quick prompts", async ({
  page,
}) => {
  await signIn(page);
  await openInstanceSettings(page, "AI assistant");
  await page
    .getByRole("button", { name: "Add quick prompt", exact: true })
    .click();
  await page
    .getByLabel("Button label", { exact: true })
    .last()
    .fill("Custom diagnostic");
  await page
    .getByLabel("Full prompt", { exact: true })
    .last()
    .fill("Explain this flow");
  for (let i = 0; i < 3; i++) {
    await page
      .locator(".assistant-prompt-setting")
      .filter({ has: page.locator('input[value="Custom diagnostic"]') })
      .getByRole("button", { name: "Move up", exact: true })
      .click();
  }
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/assistant/options")).json())
          .quick_prompts?.[0]?.label,
    )
    .toBe("Custom diagnostic");
  await page.reload();
  await expect(
    page.getByLabel("Button label", { exact: true }).first(),
  ).toHaveValue("Custom diagnostic");
  await page
    .getByRole("button", { name: "Restore translated defaults", exact: true })
    .click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/assistant/options")).json())
          .quick_prompts,
    )
    .toBeNull();
});
