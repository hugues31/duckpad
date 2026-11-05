import {
  projectPageUrl,
  settingsSections,
  workspaceTabs,
  worktreeUrl,
} from "./navigation";
import type { Translate } from "./i18n";
import type { Project, Workspace } from "./types";

export interface SearchCommand {
  key: string;
  label: string;
  detail: string;
  to?: string;
  action?: "run" | "newBranch";
}

export function searchCommands(
  workspace: Workspace,
  worktree: string,
  environment: string,
  t: Translate,
  canRun = false,
  canBranch = false,
): SearchCommand[] {
  const commands: SearchCommand[] = [];
  const add = (
    key: string,
    label: string,
    detail: string,
    to?: string,
    action?: SearchCommand["action"],
  ) => commands.push({ key, label, detail, to, action });
  add("projects", t("projects"), t("workspace"), "/projects");
  add(
    "preferences",
    t("userSettings"),
    `${t("preferences")} · ${t("apiTokens")}`,
    "/user-settings",
  );
  if (workspace.user.role === "admin")
    for (const [slug, label] of settingsSections)
      add(
        `settings:${slug}`,
        t(label),
        t("instanceSettings"),
        `/instance-settings/${slug}`,
      );
  const tree = workspace.worktrees.find((item) => item.id === worktree);
  const project: Project | undefined = workspace.projects.find(
    (item) => item.id === tree?.project,
  );
  if (!tree || !project) return commands;
  const editable =
    ["admin", "editor"].includes(project.role) && !tree.read_only;
  if (editable && canRun) add("run", t("run"), project.name, undefined, "run");
  if (editable && canBranch)
    add("newBranch", t("newBranch"), project.name, undefined, "newBranch");
  for (const tab of workspaceTabs)
    add(
      `tab:${tab}`,
      t(tab),
      project.name,
      worktreeUrl(tree.id, tab, environment),
    );
  add(
    "jobs",
    t("jobs"),
    project.name,
    projectPageUrl(project.id, "jobs", tree.id, environment),
  );
  add(
    "projectSettings",
    t("projectSettings"),
    project.name,
    projectPageUrl(project.id, "settings/participants", tree.id, environment),
  );
  for (const [slug, label] of [
    ["participants", "participants"],
    ["connections", "connections"],
    ["python", "pythonExecution"],
    ["partitions", "partitions"],
    ["general", "generalSettings"],
  ] as const)
    add(
      `projectSettings:${slug}`,
      t(label),
      `${t("projectSettings")} · ${project.name}`,
      projectPageUrl(project.id, `settings/${slug}`, tree.id, environment),
    );
  return commands;
}
