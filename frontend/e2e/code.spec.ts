import { readFile } from "node:fs/promises";
import { test, expect, type Page } from "@playwright/test";
import fr from "../src/locales/fr.json" with { type: "json" };
import { signIn } from "./helpers";

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

async function editCode(page: Page, text: string) {
  const editor = page.locator(".code-workspace .monaco-editor textarea");
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press("ControlOrMeta+V");
}

test("Code has a keyboard file tree, preserves drafts across files and tabs, saves and downloads a ZIP", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { worktree, snapshot } = await openCode(page);
  await expect(page.locator(".main-tabs a")).toHaveText([
    "Flow",
    "Code",
    "Documentation",
    "History",
  ]);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const tree = page.getByRole("tree", { name: "Project files" });
  const templates = tree.getByRole("treeitem", {
    name: "templates",
    exact: true,
  });
  await templates.focus();
  await templates.press("ArrowLeft");
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
  await expect(page.locator(".documentation-page")).toContainText("README.md");
  await page.locator(".project-documentation").fill(markdown);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/worktrees/${worktree.id}`) &&
      response.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  expect((await saved).ok()).toBeTruthy();
  await expect(page.locator(".documentation-page .muted.small")).toHaveText(
    "All changes saved",
  );
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
  await expect(page.locator(".project-documentation")).toHaveValue(changed);
  await page.reload();
  await expect(page.locator(".project-documentation")).toHaveValue(changed);
  const result = await (
    await page.request.get(`/api/worktrees/${worktree.id}`)
  ).json();
  expect(result.files["README.md"]).toBe(changed);
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

  await page
    .getByRole("treeitem", { name: "pyproject.toml", exact: true })
    .click();
  await editCode(page, "[project\n");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".banner.error")).toContainText("pyproject.toml");
  await editCode(page, manifest);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.locator(".banner.error")).toHaveCount(0);
});

test("invalid project files remain editable in Code and can be repaired", async ({
  page,
}) => {
  const { snapshot } = await openCode(page);
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
  await expect(page.locator(".main-tabs a")).toHaveText([
    fr.flow,
    fr.code,
    fr.documentation,
    fr.history,
  ]);
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
  await page.screenshot({
    path: "test-results/code-workspace.png",
    fullPage: true,
  });
});
