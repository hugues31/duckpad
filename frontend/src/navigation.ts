import { useMatches } from "react-router";

export const workspaceTabs = [
  "flow",
  "code",
  "documentation",
  "variables",
  "extensions",
  "history",
] as const;
export type WorkspaceTab = (typeof workspaceTabs)[number];
export const settingsSections = [
  ["users", "usersPermissions"],
  ["sso", "ssoSettings"],
  ["assistant", "assistant"],
  ["git-hosts", "gitHosts"],
  ["environments", "environments"],
  ["connections", "connections"],
  ["extensions", "extensions"],
  ["sql-resources", "sqlResources"],
] as const;
export type Area =
  | "home"
  | "projects"
  | "jobs"
  | "pipelines"
  | "instanceSettings"
  | "userSettings"
  | "projectSettings"
  | "notFound";
/** The `handle` of each page route, which `routes.tsx` defines. */
export interface PageHandle {
  area: Area;
  tab?: WorkspaceTab;
  section?: string;
}

export function usePageRoute() {
  const match = useMatches().at(-1)!;
  return {
    ...(match.handle as PageHandle),
    worktreeId: match.params.worktreeId,
    projectId: match.params.projectId,
  };
}

export function worktreeUrl(
  id: string,
  tab: WorkspaceTab = "flow",
  environment?: string,
  /** Extra query parameters, such as the node to reveal in the flow. */
  search: Record<string, string> = {},
) {
  const query = new URLSearchParams({
    ...(environment ? { environment } : {}),
    ...search,
  }).toString();
  return `/worktrees/${encodeURIComponent(id)}/${tab}${query ? `?${query}` : ""}`;
}

export const projectSettingsUrl = (project: string) =>
  `/projects/${encodeURIComponent(project)}/settings`;

export const SSO_RETURN_KEY = "duckpad-sign-in-return";
