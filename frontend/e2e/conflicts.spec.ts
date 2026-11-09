import { expect, test, type Locator, type Page } from "@playwright/test";
import en from "../src/locales/en.json" with { type: "json" };
import fr from "../src/locales/fr.json" with { type: "json" };
import { signIn } from "./helpers";

const sqlPath = "nodes/revenue.sql";
const sql =
  '-- @label Revenue report\n-- @param status: text = "paid"\n-- @output result\nSELECT {{ status }} AS status;\n';

async function createProject(page: Page) {
  await signIn(page);
  const tree = await (
    await page.request.post("/api/projects", {
      data: { name: "Conflict review" },
    })
  ).json();
  const initial = await (
    await page.request.get(`/api/worktrees/${tree.id}`)
  ).json();
  initial.bundle.flow.nodes = [
    {
      id: "revenue",
      label: "Revenue report",
      params: { status: "paid" },
      position: { x: 80, y: 80 },
    },
  ];
  initial.bundle.node_sql = { [sqlPath]: sql };
  const response = await page.request.put(`/api/worktrees/${tree.id}`, {
    data: { revision: initial.revision, bundle: initial.bundle },
  });
  expect(response.ok()).toBeTruthy();
  return { tree, base: await response.json() };
}

async function replaceEditor(page: Page, editor: Locator, text: string) {
  // A newly mounted editor stays hidden, and ignores focus, until it is ready.
  await expect(editor).toBeVisible();
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
}

for (const [language, theme, choice] of [
  ["en", "light", "combined"],
  ["fr", "dark", "combined"],
  ["en", "dark", "proposal"],
  ["fr", "light", "current"],
] as const) {
  test(`SQL conflict is scoped, highlighted and resolved in ${language} ${theme} using ${choice}`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const { tree, base } = await createProject(page);
    const labels = language === "fr" ? fr : en;
    await page.evaluate(
      ({ language, theme }) => {
        localStorage.setItem("duckpad-language", language);
        localStorage.setItem("duckpad-theme", theme);
      },
      { language, theme },
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/worktrees/${tree.id}/code`);
    await page
      .getByRole("treeitem", { name: "Revenue report", exact: true })
      .click();
    await replaceEditor(
      page,
      page.locator(".code-workspace .monaco-editor textarea"),
      sql + "-- proposal from tab A\n",
    );
    // A concurrent tab changes both the SQL and an unrelated field.
    base.bundle.flow.nodes[0].params.status = "changed in tab B";
    base.bundle.node_sql[sqlPath] = sql + "-- saved from tab B\n";
    const saved = await page.request.put(`/api/worktrees/${tree.id}`, {
      data: { revision: base.revision, bundle: base.bundle },
    });
    expect(saved.ok()).toBeTruthy();
    await page.getByRole("button", { name: labels.save, exact: true }).click();
    await page
      .getByRole("button", { name: labels.resolve, exact: true })
      .click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.locator(".conflict-summary")).toHaveText(
      labels.fileConflictOne.replace("{count}", "1"),
    );
    await expect(dialog.locator(".conflict-card")).toHaveCount(1);
    await expect(dialog.locator(".conflict-title")).toHaveText(
      "Revenue report · SQL",
    );
    await expect(dialog.locator(".conflict-path")).toHaveText(sqlPath);
    await expect(dialog.locator(".monaco-diff-editor")).toBeVisible();
    await expect(dialog.locator(".line-insert").first()).toBeVisible();
    await expect(dialog.locator(".line-delete").first()).toBeVisible();
    await expect(dialog).not.toContainText("flow.json");
    await expect(dialog).not.toContainText("templates/");
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBeTruthy();
    if (language === "en" && choice === "combined") {
      await page.setViewportSize({ width: 600, height: 850 });
      await expect(dialog.locator(".monaco-diff-editor")).not.toHaveClass(
        /side-by-side/,
      );
      expect(
        await dialog.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      ).toBeTruthy();
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect(dialog.locator(".monaco-diff-editor")).toHaveClass(
        /side-by-side/,
      );
    }
    if (choice === "combined") {
      await dialog
        .getByRole("button", { name: labels.combined, exact: true })
        .click();
      dialog = page.getByRole("dialog", { name: labels.combined });
      await expect(dialog.locator(".conflict-card")).toHaveCount(1);
      await replaceEditor(
        page,
        dialog.locator(".editor.modified textarea"),
        sql + "-- combined result\n",
      );
      await dialog
        .getByRole("button", { name: labels.save, exact: true })
        .click();
    } else {
      await dialog
        .getByRole("button", {
          name: labels[choice === "current" ? "keepCurrent" : "keepProposal"],
          exact: true,
        })
        .click();
    }
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const result = await (
      await page.request.get(`/api/worktrees/${tree.id}`)
    ).json();
    expect(result.conflicts).toEqual([]);
    expect(result.files[sqlPath]).toContain(
      choice === "combined"
        ? "combined result"
        : choice === "current"
          ? "saved from tab B"
          : "proposal from tab A",
    );
    if (choice === "combined")
      expect(result.bundle.flow.nodes[0].params.status).toBe(
        "changed in tab B",
      );
    await expect(page.locator(".save-status")).toHaveText(labels.saved);
    if (choice !== "current") {
      await page.getByRole("link", { name: labels.flow, exact: true }).click();
      await expect(page.locator(".react-flow__node")).toHaveCount(1);
      await page.getByRole("link", { name: labels.flow, exact: true }).focus();
      await page.keyboard.press("Control+z");
      await expect
        .poll(
          async () =>
            (await (await page.request.get(`/api/worktrees/${tree.id}`)).json())
              .files[sqlPath],
        )
        .toContain("saved from tab B");
    }
    expect(errors).toEqual([]);
  });
}

test("combined field editing keeps independent changes, distinguishes character differences and refreshes stale evidence", async ({
  page,
}) => {
  const { tree, base } = await createProject(page);
  const current = structuredClone(base.bundle);
  current.flow.nodes[0].params.status = "pending";
  current.documentation.project = "Saved independent documentation";
  expect(
    (
      await page.request.put(`/api/worktrees/${tree.id}`, {
        data: { revision: base.revision, bundle: current },
      })
    ).ok(),
  ).toBeTruthy();
  const proposal = structuredClone(base.bundle);
  proposal.flow.nodes[0].params.status = "refunded";
  const conflict = await page.request.put(`/api/worktrees/${tree.id}`, {
    data: { revision: base.revision, bundle: proposal },
  });
  expect(conflict.status()).toBe(409);
  await page.goto(`/worktrees/${tree.id}/flow`);
  await page.getByRole("button", { name: en.resolve, exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.locator(".conflict-title")).toHaveText(
    "Revenue report · status",
  );
  await expect(dialog.locator(".conflict-summary")).toHaveText(
    "1 field conflict",
  );
  await expect(dialog.locator(".git-conflict-values pre")).toHaveText([
    "paid",
    "pending",
    "refunded",
  ]);
  expect(await dialog.locator("mark").count()).toBeGreaterThan(0);
  await dialog.getByRole("button", { name: en.combined, exact: true }).click();
  dialog = page.getByRole("dialog", { name: en.combined });
  await dialog
    .getByRole("textbox", { name: /Combined value/ })
    .fill("combined");
  // A third save invalidates the reviewed revision. Do not silently reuse the draft.
  const latest = await (
    await page.request.get(`/api/worktrees/${tree.id}`)
  ).json();
  latest.bundle.flow.nodes[0].params.status = "processing";
  expect(
    (
      await page.request.put(`/api/worktrees/${tree.id}`, {
        data: { revision: latest.revision, bundle: latest.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await dialog.getByRole("button", { name: en.save, exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText(en.conflictRefreshed);
  await expect(
    dialog.getByRole("button", { name: en.save, exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole("button", { name: en.reviewChanges, exact: true })
    .click();
  dialog = page.getByRole("dialog");
  await expect(dialog.locator(".git-conflict-values pre").nth(1)).toHaveText(
    "processing",
  );
  await page.setViewportSize({ width: 600, height: 850 });
  expect(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBeTruthy();
  await dialog.getByRole("button", { name: en.combined, exact: true }).click();
  dialog = page.getByRole("dialog", { name: en.combined });
  await dialog
    .getByRole("textbox", { name: /Combined value/ })
    .fill("combined");
  await dialog.getByRole("button", { name: en.save, exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const result = await (
    await page.request.get(`/api/worktrees/${tree.id}`)
  ).json();
  expect(result.bundle.flow.nodes[0].params.status).toBe("combined");
  expect(result.bundle.documentation.project).toBe(
    "Saved independent documentation",
  );
});

test("keeping a field deleted by the proposal starts from the file version", async ({
  page,
}) => {
  const { tree, base } = await createProject(page);
  const current = structuredClone(base.bundle);
  current.flow.nodes[0].params.status = "pending";
  const proposal = structuredClone(base.bundle);
  delete proposal.flow.nodes[0].params.status;
  expect(
    (
      await page.request.put(`/api/worktrees/${tree.id}`, {
        data: { revision: base.revision, bundle: current },
      })
    ).ok(),
  ).toBeTruthy();
  expect(
    (
      await page.request.put(`/api/worktrees/${tree.id}`, {
        data: { revision: base.revision, bundle: proposal },
      })
    ).status(),
  ).toBe(409);
  await page.goto(`/worktrees/${tree.id}/flow`);
  await page.getByRole("button", { name: en.resolve, exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.locator(".conflict-value strong")).toHaveText([
    en.base,
    en.fileVersion,
    en.myProposal,
  ]);
  await dialog.getByRole("button", { name: en.combined, exact: true }).click();
  dialog = page.getByRole("dialog", { name: en.combined });
  const value = dialog.getByRole("textbox", { name: /Combined value/ });
  await expect(value).toBeDisabled();
  await dialog.getByRole("checkbox", { name: en.conflictKeepContent }).check();
  await expect(value).toHaveValue("pending");
  await value.fill("pending review");
  await dialog.getByRole("button", { name: en.save, exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const result = await (
    await page.request.get(`/api/worktrees/${tree.id}`)
  ).json();
  expect(result.bundle.flow.nodes[0].params.status).toBe("pending review");
});
