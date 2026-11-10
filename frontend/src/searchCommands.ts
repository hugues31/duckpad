import {
  projectPageUrl,
  projectSettingsSections,
  settingsSections,
  userSettingsSections,
  userSettingsUrl,
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
  const tree = workspace.worktrees.find((item) => item.id === worktree);
  const project: Project | undefined = workspace.projects.find(
    (item) => item.id === tree?.project,
  );
  const add = (
    key: string,
    label: string,
    category: string,
    to?: string,
    action?: SearchCommand["action"],
    scope?: string,
  ) =>
    commands.push({
      key,
      label,
      detail: [category, scope].filter(Boolean).join(" · "),
      keywords: `${label} ${category}`,
      to,
      action,
    });
  // The current project's actions and pages come first.
  if (tree && project) {
    const here = (
      key: string,
      label: string,
      category: string,
      to?: string,
      action?: SearchCommand["action"],
    ) => add(key, label, category, to, action, project.name);
    const editable =
      ["admin", "editor"].includes(project.role) && !tree.read_only;
    if (editable && canRun) here("run", t("run"), "", undefined, "run");
    if (editable && canBranch)
      here("newBranch", t("newBranch"), "", undefined, "newBranch");
    for (const tab of workspaceTabs)
      here(`tab:${tab}`, t(tab), "", worktreeUrl(tree.id, tab, environment));
    here(
      "jobs",
      t("jobs"),
      "",
      projectPageUrl(project.id, "jobs", tree.id, environment),
    );
    here(
      "projectSettings",
      t("projectSettings"),
      "",
      projectPageUrl(project.id, "settings/participants", tree.id, environment),
    );
    for (const [slug, label] of projectSettingsSections)
      here(
        `projectSettings:${slug}`,
        t(label),
        t("projectSettings"),
        projectPageUrl(project.id, `settings/${slug}`, tree.id, environment),
      );
  }
  add("projects", t("projects"), t("workspace"), "/projects");
  add("userSettings", t("userSettings"), "", userSettingsUrl("preferences"));
  for (const [slug, label] of userSettingsSections)
    add(
      `userSettings:${slug}`,
      t(label),
      t("userSettings"),
      userSettingsUrl(slug),
    );
  if (workspace.user.role === "admin")
    for (const [slug, label] of settingsSections)
      add(
        `settings:${slug}`,
        t(label),
        t("instanceSettings"),
        `/instance-settings/${slug}`,
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
