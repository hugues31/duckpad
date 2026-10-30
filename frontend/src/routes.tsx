import type { ComponentType } from "react";
import { matchRoutes, redirect, type RouteObject } from "react-router";
import {
  settingsSections,
  workspaceTabs,
  type PageHandle,
  type WorkspaceTab,
} from "./navigation";
import DocumentationPage from "./pages/DocumentationPage";
import FlowPage from "./pages/FlowPage";
import HistoryPage from "./pages/HistoryPage";
import HomePage from "./pages/HomePage";
import InstanceSettingsPage from "./pages/InstanceSettingsPage";
import ProjectSettingsPage from "./pages/ProjectSettingsPage";
import ProjectsPage from "./pages/ProjectsPage";
import { NotFoundPage } from "./pages/PageStates";
import UserSettingsPage from "./pages/UserSettingsPage";
import VariablesPage from "./pages/VariablesPage";
import WorktreePage, { CodePage } from "./pages/WorktreePage";

const page = (
  path: string,
  handle: PageHandle,
  Component: ComponentType,
): RouteObject => ({ path, handle, Component });

const tabPages: Record<WorkspaceTab, ComponentType> = {
  flow: FlowPage,
  code: CodePage,
  documentation: DocumentationPage,
  variables: VariablesPage,
  history: HistoryPage,
};

/** The pages rendered inside the persistent App layout. */
export const pageRoutes: RouteObject[] = [
  { index: true, handle: { area: "home" }, Component: HomePage },
  page("projects", { area: "projects" }, ProjectsPage),
  page("user-settings", { area: "userSettings" }, UserSettingsPage),
  {
    path: "instance-settings",
    handle: { area: "instanceSettings" },
    loader: () => redirect("/instance-settings/users"),
  },
  ...settingsSections.map(([slug, section]) =>
    page(
      `instance-settings/${slug}`,
      { area: "instanceSettings", section },
      InstanceSettingsPage,
    ),
  ),
  page(
    "projects/:projectId/settings",
    { area: "projectSettings" },
    ProjectSettingsPage,
  ),
  // The tabs of a working branch share its toolbar and code editor.
  {
    Component: WorktreePage,
    children: workspaceTabs.map((tab) =>
      page(
        `worktrees/:worktreeId/${tab}`,
        { area: "pipelines", tab },
        tabPages[tab],
      ),
    ),
  },
  page("*", { area: "notFound" }, NotFoundPage),
];

function matchPage(pathname: string) {
  const match = matchRoutes(pageRoutes, pathname)?.at(-1);
  return (
    match && {
      ...(match.route.handle as PageHandle),
      worktreeId: match.params.worktreeId,
    }
  );
}

export function isWorktreePage(pathname: string, worktreeId: string) {
  const match = matchPage(pathname);
  return match?.area === "pipelines" && match.worktreeId === worktreeId;
}

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
  const area = matchPage(url.pathname)?.area;
  if (!area || area === "notFound" || area === "home") return null;
  const environment = url.searchParams.get("environment");
  return (
    url.pathname +
    (area === "pipelines" && environment
      ? `?${new URLSearchParams({ environment })}`
      : "")
  );
}
