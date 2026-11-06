import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("polls Python policy changes made in another tab without reloading", async ({
  page,
}) => {
  await signIn(page);
  const created = await page.request.post("/api/projects", {
    data: { name: "Snapshot polling" },
  });
  expect(created.ok()).toBeTruthy();
  const worktree = await created.json();
  const endpoint = `/api/worktrees/${worktree.id}`;
  const before = await (await page.request.get(endpoint)).json();
  const settings = await page.context().newPage();
  try {
    await page.goto(`/worktrees/${worktree.id}/flow`);
    const python = page.getByRole("button", {
      name: "New Python template",
      exact: true,
    });
    await expect(python).toBeDisabled();
    await settings.goto(`/projects/${worktree.project}/settings/python`);
    const enabled = settings.getByLabel("Enable Python in this project", {
      exact: true,
    });
    const save = settings.getByRole("button", {
      name: "Save changes",
      exact: true,
    });

    await enabled.check();
    await save.click();
    await expect(python).toBeEnabled();

    await enabled.uncheck();
    await save.click();
    await expect(python).toBeDisabled();
    const after = await (await page.request.get(endpoint)).json();
    expect(after.revision).toBe(before.revision);
    expect(after.commit).toBe(before.commit);
  } finally {
    await settings.close();
    await page.request.delete(`/api/projects/${worktree.project}`);
  }
});
