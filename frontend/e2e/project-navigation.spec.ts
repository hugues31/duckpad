import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";
import { projectNavigationFlow } from "./project-navigation-flow";

test("project tabs preserve branch context and expose partition settings in both languages", async ({
  page,
}) => {
  await signIn(page);
  await projectNavigationFlow(page);
});

test("readers can inspect partition settings without editing or running the project", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/projects", {
      data: { name: "Read-only partition settings" },
    })
  ).json();
  const username = "partition-reader-" + Date.now();
  const password = "partition-reader-test";
  const user = await (
    await page.request.post("/api/users", {
      data: { username, password },
    })
  ).json();
  expect(
    (
      await page.request.put(
        "/api/projects/" + project.project + "/members/" + user.id,
        {
          data: { role: "reader" },
        },
      )
    ).ok(),
  ).toBeTruthy();
  await page.request.post("/api/logout");
  expect(
    (
      await page.request.post("/api/login", { data: { username, password } })
    ).ok(),
  ).toBeTruthy();
  await page.goto("/projects/" + project.project + "/settings/partitions");
  const editor = page.getByRole("form", { name: "Partition settings" });
  await expect(editor.getByLabel("Dimension name")).toBeDisabled();
  await expect(
    editor.getByRole("button", { name: "Save changes", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("navigation", { name: "Project navigation" })
    .getByRole("link", { name: "Flow", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Run all", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".partition-selector")).toHaveCount(0);
});
