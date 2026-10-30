import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

test("local collaborators save under their own identities and see them in Git history", async ({
  page,
  browser,
  baseURL,
}) => {
  await signIn(page);
  const username = `author-${Date.now()}`;
  const password = "individual-author-password";
  const user = await (
    await page.request.post("/api/users", {
      data: { username, password },
    })
  ).json();
  const project = await (
    await page.request.post("/api/projects", {
      data: { name: "Individual authors" },
    })
  ).json();
  expect(
    (
      await page.request.put(
        `/api/projects/${project.project}/members/${user.id}`,
        {
          data: { role: "editor" },
        },
      )
    ).ok(),
  ).toBeTruthy();
  const context = await browser.newContext({ baseURL });
  try {
    const member = await context.newPage();
    await member.goto("/");
    await member.getByLabel("Username", { exact: true }).fill(username);
    await member.getByLabel("Password", { exact: true }).fill(password);
    await member.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      member.getByRole("navigation", { name: "Workspace", exact: true }),
    ).toBeVisible();
    await member.goto(`/worktrees/${project.id}/documentation`);
    const documentation = member.locator(".documentation-page");
    await documentation
      .locator("textarea")
      .fill("Saved by an individual collaborator.");
    await documentation
      .getByRole("button", { name: "Save changes", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (
            await (
              await member.request.get(
                `/api/worktrees/${project.id}/git/history`,
              )
            ).json()
          ).items[0].author,
      )
      .toBe(username);
    await member
      .getByRole("button", { name: "Git synchronization", exact: true })
      .click();
    const git = member.getByRole("dialog", { name: "Project Git workspace" });
    await git
      .getByRole("button", { name: "Compare versions", exact: true })
      .first()
      .click();
    await git.locator(".git-history summary").click();
    await expect(git).toContainText(username);
    await expect(git).toContainText("admin");
  } finally {
    await context.close();
  }
});
