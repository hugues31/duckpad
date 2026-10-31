import { expect, test } from "@playwright/test";
import { openInstanceSettings, signIn } from "./helpers";
import { verifyAssistantRuns } from "./assistant-runs-flow";

let originalEnvironment: {
  label: string;
  color: string;
  confirm_before_run: boolean;
};
test.beforeEach(async ({ page }) => {
  await signIn(page);
  const catalog = await (await page.request.get("/api/catalog")).json();
  const dev = catalog.environment_details.find(
    (environment: { id: string }) => environment.id === "dev",
  );
  originalEnvironment = {
    label: dev.label,
    color: dev.color,
    confirm_before_run: dev.confirm_before_run,
  };
});

test.afterEach(async ({ page }) => {
  await page.request.put("/api/assistant/settings", {
    data: { enabled: false, providers: [] },
  });
  await page.request.put("/api/environments/dev", {
    data: originalEnvironment,
  });
});

test("approve a run after reloading, decline another and ask about a real error", async ({
  page,
}) => {
  test.setTimeout(180000);
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
  await openInstanceSettings(page, "AI assistant");
  await page
    .getByRole("button", { name: "Add quick prompt", exact: true })
    .click();
  await page
    .getByLabel("Button label", { exact: true })
    .fill("Custom diagnostic");
  await page
    .getByLabel("Full prompt", { exact: true })
    .fill("Explain this flow");
  await page
    .locator(".assistant-prompt-editor")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const prompts = page.locator(".assistant-prompt-setting");
  await expect(prompts).toHaveCount(4);
  for (let i = 0; i < 3; i++) {
    await prompts
      .filter({ hasText: "Custom diagnostic" })
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
  await expect(prompts.first()).toContainText("Custom diagnostic");
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
