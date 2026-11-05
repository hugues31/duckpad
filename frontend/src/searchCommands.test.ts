import { expect, it } from "vitest";
import { searchCommands } from "./searchCommands";
import { workspaceTabs } from "./navigation";
import en from "./locales/en.json";
import type { Workspace } from "./types";

const workspace = {
  user: { role: "member" },
  worktrees: [{ id: "tree", project: "project" }],
  projects: [{ id: "project", name: "Revenue", role: "editor" }],
} as unknown as Workspace;
const commands = (value = workspace, run = true) =>
  searchCommands(value, "tree", "prod", (key) => en[key], run, true);

it("offers every project tab, settings sections and available working branch actions", () => {
  const items = commands();
  expect(items.find((item) => item.key === "run")?.label).toBe("Run all");
  expect(items.find((item) => item.key === "newBranch")?.label).toBe(
    "New working branch",
  );
  for (const tab of workspaceTabs)
    expect(items.find((item) => item.key === `tab:${tab}`)?.to).toBe(
      `/worktrees/tree/${tab}?environment=prod`,
    );
  expect(items.find((item) => item.key === "jobs")?.to).toContain(
    "worktree=tree&environment=prod",
  );
  expect(
    items.find((item) => item.key === "projectSettings:connections")?.detail,
  ).toBe("Project settings · Revenue");
  expect(items.some((item) => item.key.startsWith("settings:"))).toBe(false);
  expect(commands(workspace, false).some((item) => item.action === "run")).toBe(
    false,
  );
});

it("hides mutations for readers, operators and job worktrees and limits instance settings to admins", () => {
  for (const role of ["reader", "operator"] as const) {
    expect(
      commands({
        ...workspace,
        projects: [{ ...workspace.projects[0], role }],
      }).some((item) => item.action),
    ).toBe(false);
  }
  expect(
    commands({
      ...workspace,
      worktrees: [{ ...workspace.worktrees[0], read_only: true }],
    }).some((item) => item.action),
  ).toBe(false);
  expect(
    commands({ ...workspace, user: { ...workspace.user, role: "admin" } }).some(
      (item) => item.key === "settings:connections",
    ),
  ).toBe(true);
  expect(
    searchCommands(workspace, "missing", "dev", (key) => en[key]).some(
      (item) => item.key === "jobs",
    ),
  ).toBe(false);
});
