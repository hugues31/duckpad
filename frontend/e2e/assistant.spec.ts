import { expect, test } from "@playwright/test";
import { openInstanceSettings, signIn } from "./helpers";
import { verifyAssistantEditing } from "./assistant-editing-flow";

// Later specs share the server: an enabled assistant adds buttons to their screens.
test.afterEach(async ({ page }) => {
  await page.request.put("/api/assistant/settings", {
    data: { enabled: false, providers: [] },
  });
});

test("configure the assistant, inspect a flow and resume a private conversation", async ({
  page,
}) => {
  test.setTimeout(90000);
  await signIn(page);
  await openInstanceSettings(page, "AI assistant");
  const enable = page.getByLabel("Enable the assistant", { exact: true });
  await expect(enable).toBeDisabled();
  // Without providers, the provider choice is the first visible step.
  await page.getByRole("button", { name: "DeepSeek", exact: true }).click();
  const provider = page.getByRole("group", { name: "DeepSeek", exact: true });
  const key = provider.getByLabel("API key", { exact: true });
  await expect(key).toBeFocused();
  await key.fill("browser-test-key");
  await expect(provider.getByText("Key not saved yet")).toBeVisible();
  // Enter adds a model identifier and never submits the settings form.
  await provider.getByLabel("Model identifier", { exact: true }).press("Enter");
  await provider.getByLabel("Model identifier", { exact: true }).fill("test");
  await provider.getByLabel("Model identifier", { exact: true }).press("Enter");
  await expect(provider.getByRole("listitem")).toHaveText(["test"]);
  // The first allowed model becomes the default and can be tested unsaved.
  await expect(
    page
      .getByLabel("Instance default model", { exact: true })
      .locator("option:checked"),
  ).toHaveText("DeepSeek · test");
  await page
    .getByRole("button", { name: "Test connection", exact: true })
    .click();
  await expect(
    page.getByText("Connection verified with DeepSeek · test.", {
      exact: true,
    }),
  ).toBeVisible();
  expect(
    (await (await page.request.get("/api/assistant/settings")).json())
      .providers,
  ).toEqual([]);
  await enable.check();
  await expect(
    page.getByText("Unsaved changes", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText("Assistant settings saved.", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".assistant-settings-heading .badge")).toHaveText(
    "Enabled",
  );
  await expect(key).toHaveValue("");
  await expect(provider.getByText("Key saved", { exact: true })).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole("group", { name: "DeepSeek", exact: true })
      .getByText("Key saved", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
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
});

test("the assistant bubble moves aside and the chat keeps the reading position", async ({
  page,
}) => {
  test.setTimeout(90000);
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
  await page.goto("/projects");
  const launcher = page.getByRole("button", {
    name: "Open AI assistant",
    exact: true,
  });
  // A drag moves the bubble to the nearest edge without opening the chat.
  const start = (await launcher.boundingBox())!;
  await page.mouse.move(start.x + 24, start.y + 24);
  await page.mouse.down();
  await page.mouse.move(300, 300, { steps: 10 });
  await page.mouse.up();
  await expect(launcher).toHaveAttribute("aria-expanded", "false");
  const left = async () => (await launcher.boundingBox())!.x;
  await expect.poll(left).toBe(20);
  await page.reload();
  await expect.poll(left).toBe(20);
  await launcher.click();
  const chat = page.getByRole("dialog", { name: "AI assistant", exact: true });
  const answers = chat.getByText("The flow contains read-only project nodes.");
  for (const [index, question] of ["One", "Two", "Three", "Four"].entries()) {
    await chat
      .getByRole("textbox", { name: "Message", exact: true })
      .fill(question);
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    await expect(answers).toHaveCount(index + 1);
    // Send returns once the turn is saved and the chat is idle.
    await expect(
      chat.getByRole("button", { name: "Send", exact: true }),
    ).toBeVisible();
  }
  const log = chat.getByRole("log", { name: "Conversation messages" });
  const remaining = () =>
    log.evaluate((e) => e.scrollHeight - e.scrollTop - e.clientHeight);
  await expect.poll(remaining).toBeLessThan(2);
  // Reopening the chat returns to where the reader left the conversation.
  await log.evaluate((e) => e.scrollTo({ top: 0 }));
  const latest = chat.getByRole("button", {
    name: "Jump to the latest message",
    exact: true,
  });
  await expect(latest).toBeVisible();
  await chat.getByRole("button", { name: "Close", exact: true }).click();
  await launcher.click();
  expect(await log.evaluate((e) => e.scrollTop)).toBe(0);
  await latest.click();
  await expect.poll(remaining).toBeLessThan(2);
  await expect(latest).toHaveCount(0);
  await chat.getByRole("button", { name: "Close", exact: true }).click();
  await launcher.click();
  await expect(answers.last()).toBeInViewport();
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
