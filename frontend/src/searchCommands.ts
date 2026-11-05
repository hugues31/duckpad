import {
  projectPageUrl,
  projectSettingsSections,
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
  /** What finds the command: its name and category, never the project name. */
  keywords: string;
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
  let project: Project | undefined;
  const add = (
    key: string,
    label: string,
    category: string,
    to?: string,
    action?: SearchCommand["action"],
  ) =>
    commands.push({
      key,
      label,
      detail: [category, project?.name].filter(Boolean).join(" · "),
      keywords: `${label} ${category}`,
      to,
      action,
    });
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
  project = workspace.projects.find((item) => item.id === tree?.project);
  if (!tree || !project) return commands;
  const editable =
    ["admin", "editor"].includes(project.role) && !tree.read_only;
  if (editable && canRun) add("run", t("run"), "", undefined, "run");
  if (editable && canBranch)
    add("newBranch", t("newBranch"), "", undefined, "newBranch");
  for (const tab of workspaceTabs)
    add(`tab:${tab}`, t(tab), "", worktreeUrl(tree.id, tab, environment));
  add(
    "jobs",
    t("jobs"),
    "",
    projectPageUrl(project.id, "jobs", tree.id, environment),
  );
  add(
    "projectSettings",
    t("projectSettings"),
    "",
    projectPageUrl(project.id, "settings/participants", tree.id, environment),
  );
  for (const [slug, label] of projectSettingsSections)
    add(
      `projectSettings:${slug}`,
      t(label),
      t("projectSettings"),
      projectPageUrl(project.id, `settings/${slug}`, tree.id, environment),
    );
  return commands;
}

/** Navigation matches its name or category; an action only the start of its
 * name, so Enter never launches one while the user looks for something else. */
export function matchCommands(commands: SearchCommand[], query: string) {
  const q = query.trim().toLocaleLowerCase();
  return commands.filter((item) =>
    item.action
      ? item.label.toLocaleLowerCase().startsWith(q)
      : item.keywords.toLocaleLowerCase().includes(q),
  );
}
