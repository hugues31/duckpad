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

test("project links without branch context return to the branch opened last", async ({
  page,
}) => {
  await signIn(page);
  const project = await (
    await page.request.post("/api/projects", {
      data: { name: "Branch context fallback" },
    })
  ).json();
  const branch = await (
    await page.request.post(`/api/worktrees/${project.id}/branches`, {
      data: { name: "feature/python" },
    })
  ).json();
  const endpoint = `/api/worktrees/${branch.id}`;
  const snapshot = await (await page.request.get(endpoint)).json();
  snapshot.bundle.flow.nodes = [
    { id: "python", language: "python", params: {} },
  ];
  snapshot.bundle.flow.edges = [];
  snapshot.bundle.node_sql = {
    "nodes/python.py":
      "import duckpad as dp\n\n\nclass Report(dp.Node):\n    def run(self) -> None:\n        pass\n",
  };
  expect(
    (
      await page.request.put(endpoint, {
        data: { revision: snapshot.revision, bundle: snapshot.bundle },
      })
    ).ok(),
  ).toBeTruthy();
  await page.goto(`/worktrees/${branch.id}/flow?node=python`);
  // Python's own settings link carries no branch: the tabs keep this one.
  await page
    .getByRole("link", { name: "Open Python settings", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings\/python$/);
  await expect(
    page.getByRole("heading", { name: "Project settings", exact: true }),
  ).toBeFocused();
  await page
    .getByRole("navigation", { name: "Project navigation" })
    .getByRole("link", { name: "Flow", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/worktrees/${branch.id}/flow`));
});
