import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers";
import type { Bundle, Snapshot } from "../src/types";
import fr from "../src/locales/fr.json" with { type: "json" };

async function project(page: Page, change?: (bundle: Bundle) => void) {
  await signIn(page);
  const created = await page.request.post("/api/projects", {
    data: { name: "Frontend regressions" },
  });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  const endpoint = `/api/worktrees/${id}`;
  const read = async (): Promise<Snapshot> =>
    (await page.request.get(endpoint)).json();
  const initial = await read();
  const bundle = initial.bundle!;
  bundle.templates.rows =
    "-- @label Rows\n-- @output result\nSELECT 1 AS amount, 'input' AS input_only;";
  bundle.templates.output =
    "-- @label Output\n-- @input source\n-- @output result\nSELECT amount FROM {{ source }};\n-- @test rejected: warning\nSELECT * FROM {{ result }} WHERE amount > 0;";
  bundle.flow.nodes = [
    { id: "rows", template: "rows", params: {}, position: { x: 0, y: 0 } },
    {
      id: "filtered",
      template: "filter",
      params: { condition: "true" },
      position: { x: 350, y: 0 },
    },
    {
      id: "output",
      template: "output",
      params: {},
      position: { x: 700, y: 0 },
    },
  ];
  bundle.flow.edges = [
    {
      id: "first",
      source: "rows",
      sourceHandle: "result",
      target: "filtered",
      targetHandle: "source",
    },
    {
      id: "second",
      source: "filtered",
      sourceHandle: "result",
      target: "output",
      targetHandle: "source",
    },
  ];
  change?.(bundle);
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: initial.revision, bundle },
      })
    ).ok(),
  ).toBe(true);
  await page.goto(`/worktrees/${id}/flow?node=filtered`);
  await expect(page.locator(".react-flow__node")).toHaveCount(3);
  return { id, endpoint, read };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("grouping waits for an Inspector save, and Ctrl+Z undoes the group before the edit", async ({
  page,
}) => {
  const { endpoint, read } = await project(page);
  const release = deferred();
  const started = deferred();
  let savedRevision = "";
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    savedRevision = (await response.json()).revision;
    started.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page
    .locator(".inspector")
    .getByLabel("Display name", { exact: true })
    .fill("Reviewed filter");
  await started.promise;
  await page.locator(".group-button").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Component name").fill("Reviewed group");
  const request = page.waitForRequest((r) => r.url().endsWith("/group"));
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  release.resolve();
  expect((await request).postDataJSON().revision).toBe(savedRevision);
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(async () =>
      Object.values((await read()).bundle!.components).map(
        (component) => component.name,
      ),
    )
    .toContain("Reviewed group");
  await page.getByRole("link", { name: "Flow", exact: true }).focus();
  await page.keyboard.press("Control+z");
  await expect
    .poll(
      async () =>
        (await read()).bundle!.flow.nodes.find((node) => node.id === "filtered")
          ?.label,
    )
    .toBe("Reviewed filter");
  expect(
    Object.values((await read()).bundle!.components).some(
      (component) => component.name === "Reviewed group",
    ),
  ).toBe(false);
});

for (const section of [
  "sso",
  "assistant",
  "sql-resources",
  "git-hosts",
  "extensions",
]) {
  test(`leaving modified ${section} settings confirms and preserves a cancelled draft`, async ({
    page,
  }) => {
    await signIn(page);
    await page.goto(`/instance-settings/${section}`);
    if (section === "sso")
      await page
        .getByLabel("Client secret", { exact: true })
        .fill("unsaved-test-secret");
    if (section === "assistant") {
      await page.getByRole("button", { name: "DeepSeek", exact: true }).click();
      await page
        .getByLabel("API key", { exact: true })
        .fill("unsaved-test-key");
    }
    if (section === "sql-resources")
      await page.getByLabel("Threads per session", { exact: true }).fill("3");
    if (section === "git-hosts")
      await page
        .getByLabel("Trusted SSH host keys", { exact: true })
        .fill("unsaved host key");
    if (section === "extensions")
      await page
        .getByRole("checkbox", {
          name: "Allow unsigned extensions",
          exact: true,
        })
        .click();
    await page
      .getByRole("link", { name: "Users and permissions", exact: true })
      .click();
    const guard = page.getByRole("dialog", {
      name: "Unsaved changes",
      exact: true,
    });
    await expect(guard).toBeVisible();
    await guard
      .getByRole("button", { name: "Stay on this page", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/instance-settings/${section}$`));
    // A tab close gets the same protection, without storing the draft in browser storage.
    expect(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(true);
    await page
      .getByRole("link", { name: "Users and permissions", exact: true })
      .click();
    await guard
      .getByRole("button", { name: "Discard and leave", exact: true })
      .click();
    await expect(page).toHaveURL(/\/instance-settings\/users$/);
  });
}

test("a variable diagnostic asks before replacing the active variable draft", async ({
  page,
}) => {
  const { id } = await project(page, (bundle) => {
    bundle.variables = {
      first: { type: "text", default: "saved" },
      broken: { type: "number", default: "invalid" },
    };
  });
  await page.goto(`/worktrees/${id}/variables?variable=first`);
  const editor = page.getByRole("complementary", {
    name: "first",
    exact: true,
  });
  await editor
    .getByLabel("Description", { exact: true })
    .fill("Keep this draft");
  await page
    .getByRole("button", { name: "Open in Variables", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Unsaved changes",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    editor.getByRole("textbox", { name: "Description", exact: true }),
  ).toHaveValue("Keep this draft");
  await expect(page).toHaveURL(/variable=first/);
  await page
    .getByRole("button", { name: "Open in Variables", exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Discard changes", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "broken", exact: true }),
  ).toBeVisible();
});

test("Stop before conversation creation prevents the message, and a busy debug request opens the chat", async ({
  page,
}) => {
  const { endpoint } = await project(page);
  await page.request.put("/api/assistant/settings", {
    data: {
      enabled: true,
      providers: [
        {
          id: "primary",
          kind: "deepseek",
          api_key: "test-key",
          models: ["test"],
        },
      ],
      default_provider: "primary",
      default_model: "test",
    },
  });
  await page.reload();
  const release = deferred();
  const started = deferred();
  const sent: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().includes("/assistant/conversations")
    )
      sent.push(request.url());
  });
  await page.route(`**${endpoint}`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    started.resolve();
    await release.promise;
    await route.continue();
  });
  try {
    await page
      .locator(".inspector")
      .getByLabel("Display name", { exact: true })
      .fill("Pending edit");
    await started.promise;
    await page
      .getByRole("button", { name: "Open AI assistant", exact: true })
      .click();
    const chat = page.getByRole("dialog", {
      name: "AI assistant",
      exact: true,
    });
    await chat
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Explain the flow");
    await chat.getByRole("button", { name: "Send", exact: true }).click();
    await chat.getByRole("button", { name: "Close", exact: true }).click();
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("duckpad:ask-assistant", {
          detail: { environment: "dev", prompt: "Explain this error" },
        }),
      ),
    );
    await expect(chat).toBeVisible();
    await expect(chat).toContainText("Wait for the current response to finish");
    await chat.getByRole("button", { name: "Stop", exact: true }).click();
    release.resolve();
    await expect(
      chat.getByRole("button", { name: "Send", exact: true }),
    ).toBeVisible();
    await expect(
      chat.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("Explain the flow");
    expect(sent).toEqual([]);
  } finally {
    release.resolve();
    await page.request.put("/api/assistant/settings", {
      data: { enabled: false, providers: [] },
    });
  }
});

test("the Inspector translates builtin titles and names a missing template", async ({
  page,
}) => {
  const { endpoint, read } = await project(page);
  await page.evaluate(() => localStorage.setItem("duckpad-language", "fr"));
  await page.reload();
  await expect(page.locator(".inspector-title")).toContainText(fr.filter);
  const snapshot = await read();
  snapshot.bundle!.flow.nodes.find((node) => node.id === "filtered")!.template =
    "missing_template";
  await page.request.put(endpoint, {
    data: { revision: snapshot.revision, bundle: snapshot.bundle },
  });
  await expect(page.locator(".inspector-title")).toContainText(
    "missing_template",
  );
});

test("binding diagnostics distinguish overlapping parameter names", async ({
  page,
}) => {
  await project(page, (bundle) => {
    bundle.templates.paths =
      '-- @label Paths\n-- @input source\n-- @param file: text = ""\n-- @param file_name: text = ""\n-- @output result\nSELECT * FROM {{ source }};';
    const node = bundle.flow.nodes.find((node) => node.id === "filtered")!;
    node.template = "paths";
    node.params = { file: { $var: "path" }, file_name: { $var: "count" } };
    bundle.variables = {
      path: { type: "text", default: "data.csv" },
      count: { type: "number", default: 1 },
    };
  });
  const inspector = page.locator(".inspector");
  await expect(inspector.locator(".variable-binding")).toHaveCount(2);
  await expect(inspector.locator(".variable-binding").first()).not.toHaveClass(
    /has-error/,
  );
  await expect(inspector.locator(".variable-binding").last()).toHaveClass(
    /has-error/,
  );
});

test("Git comparison draws added and removed edges and resets a missing component scope", async ({
  page,
}, info) => {
  const { id, endpoint, read } = await project(page);
  const before = await read();
  const grouped = await page.request.post(`${endpoint}/group`, {
    data: {
      revision: before.revision,
      nodes: ["filtered"],
      name: "Review group",
      parameters: {},
    },
  });
  expect(grouped.ok()).toBe(true);
  const groupedSnapshot: Snapshot = await grouped.json();
  // Replacing connections gives the comparison distinct added and removed edges.
  for (const edge of groupedSnapshot.bundle!.flow.edges)
    edge.id = `replacement_${edge.id}`;
  groupedSnapshot.bundle!.flow.nodes.find((node) => node.component)!.position =
    { x: 350, y: 160 };
  const replaced = await page.request.put(endpoint, {
    data: {
      revision: groupedSnapshot.revision,
      bundle: groupedSnapshot.bundle,
    },
  });
  expect(replaced.ok()).toBe(true);
  const after: Snapshot = await replaced.json();
  await page.goto(`/worktrees/${id}/history`);
  await page
    .getByRole("button", { name: "Compare versions", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Project Git workspace",
    exact: true,
  });
  await dialog.getByLabel("A: reference", { exact: true }).fill(before.commit);
  await dialog.getByLabel("B: target", { exact: true }).fill(after.commit);
  const graph = dialog.locator(".comparison-graph");
  for (const [theme, success, danger] of [
    ["light", "rgb(31, 122, 77)", "rgb(163, 62, 54)"],
    ["dark", "rgb(142, 224, 178)", "rgb(244, 173, 164)"],
  ]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await expect
      .poll(async () =>
        graph
          .locator(".react-flow__edge-path")
          .evaluateAll((edges) =>
            edges.map((edge) => getComputedStyle(edge).stroke),
          ),
      )
      .toEqual(expect.arrayContaining([success, danger]));
    await dialog.screenshot({
      path: info.outputPath(`comparison-edges-${theme}.png`),
      animations: "disabled",
    });
  }
  const scope = dialog.locator(".git-scope").getByRole("combobox");
  const component = Object.keys(after.bundle!.components)[0];
  await scope.selectOption(`component/${component}`);
  await expect(graph.locator(".react-flow__node")).toHaveCount(1);
  await dialog.getByLabel("B: target", { exact: true }).fill(before.commit);
  await expect(scope).toHaveValue("");
  await expect(graph.locator(".react-flow__node")).toHaveCount(3);
});

test("failing rows drop an incompatible input sample before returning to output rows", async ({
  page,
}) => {
  const { id, endpoint } = await project(page);
  const launch = await page.request.post(`${endpoint}/runs`, {
    data: { environment: "dev" },
  });
  expect(launch.ok()).toBe(true);
  const run = await launch.json();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(`/api/runs/${run.id}`)).json()).status,
    )
    .toBe("success");
  await page.goto(`/worktrees/${id}/flow?node=output`);
  const panel = page.getByRole("region", { name: "Results", exact: true });
  await panel
    .getByLabel("Output", { exact: true })
    .selectOption("input:source");
  await panel.getByRole("button", { name: /^Sample:/ }).click();
  const sample = page.getByRole("dialog", { name: "Sample", exact: true });
  await sample
    .getByRole("textbox", { name: "Filter", exact: true })
    .fill("input_only = 'input'");
  await expect(sample.getByRole("status")).toHaveText("1 matching rows");
  await sample.getByRole("button", { name: "Apply", exact: true }).click();
  await panel.getByRole("tab", { name: /^Tests/ }).click();
  await panel.getByRole("button", { name: /Show the 1 failing row/ }).click();
  await expect(panel.locator(".sample-chip.failing")).toBeVisible();
  await panel.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(panel.getByLabel("Output", { exact: true })).toHaveValue(
    "result",
  );
  await expect(panel.locator(".data-table tbody tr")).toHaveCount(1);
  await expect(panel.locator(".notice.error")).toHaveCount(0);
  await expect(panel.locator(".sample-chip")).toHaveCount(0);
});
