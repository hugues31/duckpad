import { matchRoutes, useMatches, type RouteObject } from "react-router";

export const workspaceTabs = [
  "flow",
  "code",
  "documentation",
  "history",
] as const;
export type WorkspaceTab = (typeof workspaceTabs)[number];
export const settingsSections = [
  ["", "instanceGeneral"],
  ["users", "usersPermissions"],
  ["sso", "ssoSettings"],
  ["environments", "environments"],
  ["connections", "connections"],
] as const;
export type Area =
  | "home"
  | "projects"
  | "pipelines"
  | "instanceSettings"
  | "userSettings"
  | "projectSettings"
  | "notFound";
type PageRoute = { area: Area; tab?: WorkspaceTab; section?: string };

// App is the persistent workspace layout; leaf handles select its existing panels.
const EmptyRoute = () => null;
const page = (path: string, handle: PageRoute): RouteObject => ({
  path,
  handle,
  Component: EmptyRoute,
});
export const pageRoutes: RouteObject[] = [
  { index: true, handle: { area: "home" }, Component: EmptyRoute },
  page("projects", { area: "projects" }),
  page("user-settings", { area: "userSettings" }),
  ...settingsSections.map(([slug, section]) =>
    page(`instance-settings${slug ? `/${slug}` : ""}`, {
      area: "instanceSettings",
      section,
    }),
  ),
  page("projects/:projectId/settings", { area: "projectSettings" }),
  ...workspaceTabs.map((tab) =>
    page(`worktrees/:worktreeId/${tab}`, { area: "pipelines", tab }),
  ),
  page("*", { area: "notFound" }),
];

export function usePageRoute() {
  const match = useMatches().at(-1)!;
  return {
    ...(match.handle as PageRoute),
    worktreeId: match.params.worktreeId,
    projectId: match.params.projectId,
  };
}

export function worktreeUrl(
  id: string,
  tab: WorkspaceTab = "flow",
  environment?: string,
) {
  const query = environment ? `?${new URLSearchParams({ environment })}` : "";
  return `/worktrees/${encodeURIComponent(id)}/${tab}${query}`;
}

export function isWorktreePage(pathname: string, worktreeId: string) {
  const match = matchRoutes(pageRoutes, pathname)?.at(-1);
  return (
    (match?.route.handle as PageRoute | undefined)?.area === "pipelines" &&
    match?.params.worktreeId === worktreeId
  );
}

export const SSO_RETURN_KEY = "duckpad-sign-in-return";

/** Accept only application routes and the non-secret environment selection. */
export function signInReturn(value: string | null): string | null {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  )
    return null;
  const url = new URL(value, window.location.origin);
  if (url.origin !== window.location.origin) return null;
  const match = matchRoutes(pageRoutes, url.pathname)?.at(-1);
  const area = (match?.route.handle as PageRoute | undefined)?.area;
  if (!area || area === "notFound" || area === "home") return null;
  const environment = url.searchParams.get("environment");
  return (
    url.pathname +
    (area === "pipelines" && environment
      ? `?${new URLSearchParams({ environment })}`
      : "")
  );
}
