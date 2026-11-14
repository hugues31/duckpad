import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import fr from "../src/locales/fr.json" with { type: "json" };
import { editCode, editOverview, signIn } from "./helpers";

async function openCode(page: Page) {
  await signIn(page);
  const response = await page.request.post("/api/example", { data: {} });
  expect(response.ok()).toBeTruthy();
  const worktree = await response.json();
  await page.goto(`/worktrees/${worktree.id}/flow`);
  await page.getByRole("link", { name: "Code", exact: true }).click();
  await expect(page.locator(".code-workspace .monaco-editor")).toBeVisible();
  return {
    worktree,
    snapshot: await (
      await page.request.get(`/api/worktrees/${worktree.id}`)
    ).json(),
  };
}

test("file filtering reveals nested matches and keeps the current draft", async ({
  page,
}) => {
  const { snapshot } = await openCode(page);
  await editCode(page, snapshot.files["README.md"] + "\nFiltered draft\n");
  const filter = page.getByRole("textbox", { name: "Filter files…" });
  const tree = page.getByRole("tree", { name: "Project files" });
  await filter.fill("TEMPLATES/SQL.SQL");
  await expect(
    tree.getByRole("treeitem", { name: "templates/sql.sql", exact: true }),
  ).toBeVisible();
  await expect(
    tree.getByRole("treeitem", { name: "README.md", exact: true }),
  ).toHaveCount(0);
  await filter.press("Enter");
  await expect(page.locator(".code-file-heading")).toContainText(
    "templates/sql.sql",
  );
  await filter.fill("not-a-project-file");
  await expect(
    page.getByRole("status").filter({ hasText: "No matching results" }),
  ).toBeVisible();
  await expect(page.locator(".code-file-heading")).toContainText(
    "templates/sql.sql",
  );
  await filter.press("Escape");
  await tree.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await expect(page.locator(".code-editor-body")).toContainText(
    "Filtered draft",
  );
  await page.getByRole("button", { name: "Discard changes" }).click();
});

test("Code has a keyboard file tree, preserves drafts across files and tabs, saves and downloads a ZIP", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { worktree, snapshot } = await openCode(page);
  await expect(page.locator(".code-file-heading")).toContainText("README.md");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const tree = page.getByRole("tree", { name: "Project files" });
  const templates = tree.getByRole("treeitem", {
    name: "templates",
    exact: true,
  });
  await templates.focus();
  await expect(templates).toHaveAttribute("aria-expanded", "false");
  const sql = tree.getByRole("treeitem", {
    name: "templates/sql.sql",
    exact: true,
  });
  await expect(sql).toHaveCount(0);
  await templates.press("ArrowRight");
  await templates.press("ArrowRight");
  await expect(
    tree.getByRole("treeitem", { name: /^templates\// }).first(),
  ).toBeFocused();
  await sql.click();
  await expect(sql).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".code-file-heading")).toContainText(
    "templates/sql.sql",
  );
  const edited =
    snapshot.files["templates/sql.sql"] + "\n-- Saved from the Code tab\n";
  await editCode(page, edited);
  await expect(
    page.getByRole("button", { name: "Download project ZIP" }),
  ).toBeDisabled();
  await tree.getByRole("treeitem", { name: "flow.json", exact: true }).click();
  await sql.click();
  await expect(page.locator(".code-editor-body")).toContainText(
    "Saved from the Code tab",
  );
  await page.getByRole("link", { name: "Flow", exact: true }).click();
  await page.getByRole("link", { name: "Code", exact: true }).click();
  await expect(page.locator(".code-editor-body")).toContainText(
    "Saved from the Code tab",
  );
  // A concurrent edit to a different file must survive the revision-based save.
  const files = {
    ...snapshot.files,
    "README.md": "Concurrent documentation",
  };
  expect(
    (
      await page.request.put(`/api/worktrees/${worktree.id}`, {
        data: { revision: snapshot.revision, files },
      })
    ).ok(),
  ).toBeTruthy();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Download project ZIP" }),
  ).toBeEnabled();
  const saved = await (
    await page.request.get(`/api/worktrees/${worktree.id}`)
  ).json();
  expect(saved.files["templates/sql.sql"]).toBe(edited);
  expect(saved.bundle.documentation.project).toBe("Concurrent documentation");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download project ZIP" }).click();
  const archive = await download;
  expect(archive.suggestedFilename()).toBe("duckpad-project.zip");
  const bytes = await readFile((await archive.path())!);
  expect(bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
  expect(bytes.length).toBeGreaterThan(100);
  await page.reload();
  await page.getByRole("link", { name: "Code", exact: true }).click();
  await page.getByRole("treeitem", { name: "templates", exact: true }).click();
  await page
    .getByRole("treeitem", { name: "templates/sql.sql", exact: true })
    .click();
  await expect(page.locator(".code-editor-body")).toContainText(
    "Saved from the Code tab",
  );
  expect(errors).toEqual([]);
});

test("project Markdown and Python dependencies round trip between Code, Documentation and ZIP", async ({
  page,
}) => {
  const { worktree, snapshot } = await openCode(page);
  const manifest =
    snapshot.files["pyproject.toml"].replace(
      "dependencies = [",
      'dependencies = ["pandas>=2", ',
    ) + '\n# Keep custom settings\n[tool.custom]\nvalue = "example"\n';
  await page
    .getByRole("treeitem", { name: "pyproject.toml", exact: true })
    .click();
  await editCode(page, manifest);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();

  const markdown = "# Revenue\n\nProject **business context**.\n";
  await page.getByRole("link", { name: "Documentation", exact: true }).click();
  const editor = await editOverview(page);
  await expect(page.locator(".documentation-page")).toContainText("README.md");
  await editor.fill(markdown);
  // The rendered overview shows the draft; saving stays available from it.
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Revenue", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".documentation-preview strong")).toHaveText(
    "business context",
  );
  await expect(page.locator(".documentation-actions")).toContainText(
    "Unsaved changes",
  );
  await expect(
    page.getByRole("heading", { name: "Pipeline", exact: true }),
  ).toBeVisible();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/worktrees/${worktree.id}`) &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(
    page.locator(".documentation-actions").getByRole("status"),
  ).toHaveText("All changes saved");
  await page.getByRole("link", { name: "Code", exact: true }).click();
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await expect(page.locator(".code-editor-body")).toContainText(
    "business context",
  );
  const changed = markdown + "\nEdited from Code.\n";
  await editCode(page, changed);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  await page.getByRole("link", { name: "Documentation", exact: true }).click();
  // The tab opens on the rendered overview, with the text saved from Code.
  await expect(page.locator(".documentation-preview")).toContainText(
    "Edited from Code.",
  );
  await editOverview(page);
  await expect(editor).toHaveValue(changed);
  await editor.evaluate((element: HTMLTextAreaElement) => {
    const start = element.value.indexOf("Edited from Code.");
    element.setSelectionRange(start, start + "Edited from Code.".length);
  });
  await page.getByRole("button", { name: "Bold", exact: true }).click();
  const formatted = changed.replace(
    "Edited from Code.",
    "**Edited from Code.**",
  );
  await expect(editor).toHaveValue(formatted);
  await expect(editor).toBeFocused();
  // Formats go through the browser's undo history.
  await page.keyboard.press("ControlOrMeta+Z");
  await expect(editor).toHaveValue(changed);
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect(editor).toHaveValue(formatted);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator(".documentation-preview strong").last()).toHaveText(
    "Edited from Code.",
  );
  await page.reload();
  await editOverview(page);
  await expect(editor).toHaveValue(formatted);
  const toolbar = page.getByRole("group", { name: "Markdown formatting" });
  // The editor takes the width of the document, beside the outline.
  expect((await editor.boundingBox())!.width).toBeGreaterThan(900);
  await page.setViewportSize({ width: 760, height: 800 });
  await expect(toolbar).toBeVisible();
  expect(
    await page
      .locator(".documentation-page")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  const result = await (
    await page.request.get(`/api/worktrees/${worktree.id}`)
  ).json();
  expect(result.files["README.md"]).toBe(formatted);
  expect(JSON.parse(result.files["documentation.json"])).not.toHaveProperty(
    "project",
  );
  expect(result.files["pyproject.toml"]).toBe(manifest);
  expect(result.diagnostics).toEqual([]);

  await page.getByRole("link", { name: "Code", exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download project ZIP" }).click();
  const bytes = await readFile((await (await download).path())!);
  expect(bytes.includes(Buffer.from("README.md"))).toBeTruthy();
  expect(bytes.includes(Buffer.from("pyproject.toml"))).toBeTruthy();
});

test("invalid project files remain editable in Code and can be repaired", async ({
  page,
}) => {
  const { snapshot } = await openCode(page);
  await page.getByRole("treeitem", { name: "flow.json", exact: true }).click();
  await editCode(page, "invalid JSON");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".banner.error")).toBeVisible();
  await page.getByRole("link", { name: "Flow", exact: true }).click();
  await page
    .locator(".banner.error")
    .getByRole("button", { name: "Open files" })
    .click();
  await expect(
    page.getByRole("link", { name: "Code", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await editCode(page, snapshot.files["flow.json"]);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".banner.error")).toHaveCount(0);
  await page.getByRole("link", { name: "Flow", exact: true }).click();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
});

test("conflicting saves preserve the draft and download failures can be retried", async ({
  page,
}) => {
  const { worktree, snapshot } = await openCode(page);
  await page.getByRole("treeitem", { name: "templates", exact: true }).click();
  await page
    .getByRole("treeitem", { name: "templates/sql.sql", exact: true })
    .click();
  await editCode(
    page,
    snapshot.files["templates/sql.sql"] + "\n-- Local draft\n",
  );
  const files = {
    ...snapshot.files,
    "templates/sql.sql":
      snapshot.files["templates/sql.sql"] + "\n-- Concurrent edit\n",
  };
  expect(
    (
      await page.request.put(`/api/worktrees/${worktree.id}`, {
        data: { revision: snapshot.revision, files },
      })
    ).ok(),
  ).toBeTruthy();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.locator(".code-workspace").getByRole("alert"),
  ).toContainText("Concurrent edits conflict");
  await expect(page.locator(".code-editor-body")).toContainText("Local draft");
  await page.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.locator(".code-editor-body")).toContainText(
    "Concurrent edit",
  );
  await page.route("**/archive.zip", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Download temporarily unavailable" },
    }),
  );
  await page.getByRole("button", { name: "Download project ZIP" }).click();
  await expect(
    page.locator(".code-workspace").getByRole("alert"),
  ).toContainText("Download temporarily unavailable");
  await page.unroute("**/archive.zip");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download project ZIP" }).click();
  expect(await (await download).failure()).toBeNull();
});

test("Code is localized and keeps the tree beside Monaco at a narrow width", async ({
  page,
}) => {
  await openCode(page);
  await page.locator(".account .avatar").click();
  await page
    .getByRole("menuitemradio", { name: "French", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: fr.downloadProject }),
  ).toBeVisible();
  await page.setViewportSize({ width: 760, height: 800 });
  const tree = await page.getByRole("tree", { name: fr.files }).boundingBox();
  const editor = await page
    .locator(".code-workspace .monaco-editor")
    .boundingBox();
  expect(tree!.x + tree!.width).toBeLessThanOrEqual(editor!.x);
  expect(editor!.width).toBeGreaterThan(300);
  expect(editor!.height).toBeGreaterThan(300);
});
