import { expect, test } from "@playwright/test";
import { openInstanceSettings, signIn } from "./helpers";
import { verifyAssistantEditing } from "./assistant-editing-flow";

test("configure the assistant, inspect a flow and resume a private conversation", async ({
  page,
}) => {
  test.setTimeout(90000);
  await signIn(page);
  await openInstanceSettings(page, "AI assistant");
  await page.getByRole("button", { name: "Add provider", exact: true }).click();
  await page
    .getByLabel("Provider type", { exact: true })
    .selectOption("deepseek");
  await page.getByLabel("API key", { exact: true }).fill("browser-test-key");
  await page.getByLabel("Allowed models", { exact: true }).fill("test");
  await page
    .getByLabel("Instance default model", { exact: true })
    .selectOption({ label: "DeepSeek · test" });
  await page.getByLabel("Enable the assistant", { exact: true }).check();
  await page
    .getByRole("button", { name: "Save and test", exact: true })
    .click();
  await expect(
    page.getByText("Provider connection verified.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  const response = await page.request.post("/api/example", { data: {} });
  expect(response.ok()).toBeTruthy();
  const example = await response.json();
  const id = example.id;
  await page.goto(`/worktrees/${id}/flow`);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Open AI assistant", exact: true })
    .click();
  const chat = page.getByRole("dialog", { name: "AI assistant", exact: true });
  await chat
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Explain this flow");
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    chat.getByText("The flow contains read-only project nodes."),
  ).toBeVisible();
  await expect(chat.locator(".assistant-tool")).toContainText("Reads the flow");
  await chat.locator(".assistant-tool summary").click();
  await expect(chat.locator(".assistant-tool pre")).toContainText("items");
  await expect(chat.locator("pre code")).toHaveText("SELECT 1;\n");
  await chat
    .getByRole("button", { name: "Maximize assistant", exact: true })
    .click();
  await expect(
    chat.getByRole("complementary", { name: "Conversations" }),
  ).toBeVisible();
  await chat
    .getByRole("textbox", { name: "Conversation title" })
    .fill("Northstar discussion");
  await chat.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    chat.getByRole("button", { name: "Northstar discussion main" }),
  ).toBeVisible();
  await chat
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  await chat.getByRole("button", { name: "Northstar discussion main" }).click();
  await expect(
    chat.getByText("The flow contains read-only project nodes."),
  ).toBeVisible();
  await chat
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("And the SQL?");
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    chat.getByText("The flow contains read-only project nodes."),
  ).toHaveCount(2);
  await page.reload();
  await page
    .getByRole("button", { name: "Open AI assistant", exact: true })
    .click();
  await chat
    .getByRole("button", { name: "Maximize assistant", exact: true })
    .click();
  await chat.getByRole("button", { name: "Northstar discussion main" }).click();
  await expect(
    chat.getByText("The flow contains read-only project nodes."),
  ).toHaveCount(2);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Open AI assistant", exact: true }),
  ).toBeFocused();
  const settings = await (
    await page.request.get("/api/assistant/settings")
  ).json();
  await page.request.put("/api/assistant/settings", {
    data: { ...settings, enabled: false, providers: [] },
  });
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Open AI assistant", exact: true }),
  ).toHaveCount(0);
});

test("a pending Code file is saved before the assistant turn", async ({
  page,
}) => {
  await signIn(page);
  const configured = await page.request.put("/api/assistant/settings", {
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
  });
  expect(configured.ok()).toBeTruthy();
  const example = await (
    await page.request.post("/api/example", { data: {} })
  ).json();
  await page.goto(`/worktrees/${example.id}/code`);
  await page
    .getByRole("button", { name: "Create variables.json", exact: true })
    .click();
  await expect(page.locator(".code-file-heading")).toContainText(
    "variables.json",
  );
  await page
    .getByRole("button", { name: "Open AI assistant", exact: true })
    .click();
  const chat = page.getByRole("dialog", { name: "AI assistant", exact: true });
  await expect(chat.locator(".assistant-context").first()).not.toContainText(
    "variables.json",
  );
  await chat
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Which variables exist?");
  await chat.getByRole("button", { name: "Send", exact: true }).click();
  await expect(
    chat.getByText("The flow contains read-only project nodes."),
  ).toBeVisible();
  await expect(chat.getByRole("alert")).toHaveCount(0);
  const saved = await (
    await page.request.get(`/api/worktrees/${example.id}`)
  ).json();
  expect(saved.files["variables.json"]).toBeDefined();
  await page.request.put("/api/assistant/settings", {
    data: { enabled: false, providers: [] },
  });
});

test("assistant writes appear on the canvas and undo preserves a manual SQL edit", async ({
  page,
}) => {
  test.setTimeout(180000);
  await signIn(page);
  const configured = await page.request.put("/api/assistant/settings", {
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
  });
  expect(configured.ok()).toBeTruthy();
  await verifyAssistantEditing(page);
});
