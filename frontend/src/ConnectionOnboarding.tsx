import { Link as RouterLink } from "react-router";
import { withQuery } from "./api";
import { useT } from "./i18n";
import { projectSettingsUrl } from "./navigation";
import type { Snapshot } from "./types";

export default function ConnectionOnboarding({
  workspace,
  snapshot,
  worktree,
  fullNode,
}: {
  workspace: import("./types").Workspace;
  snapshot: Snapshot;
  worktree: string;
  fullNode: string;
}) {
  const t = useT();
  return (
    <div className="source-empty notice">
      <p>{t("noProjectConnections")}</p>
      {workspace.user.role === "admin" ? (
        <>
          <RouterLink
            className="button secondary"
            to={withQuery("/instance-settings/connections", {
              project: snapshot.worktree.project,
              worktree,
              node: fullNode,
            })}
          >
            {t("createSourceConnection")}
          </RouterLink>
          {/* Only an existing database connection can be authorized. */}
          {workspace.catalog.connections.some(
            (c) =>
              workspace.catalog.connectors.find(
                (connector) => connector.id === c.connector,
              )?.family !== "storage",
          ) && (
            <RouterLink
              className="button secondary"
              to={withQuery(
                projectSettingsUrl(snapshot.worktree.project, "connections"),
                { worktree },
              )}
            >
              {t("authorizeSourceConnection")}
            </RouterLink>
          )}
        </>
      ) : (
        <>
          <p>{t("askAdministratorHint")}</p>
          <RouterLink
            className="button secondary"
            to={withQuery(
              projectSettingsUrl(snapshot.worktree.project, "participants"),
              { worktree },
            )}
          >
            {t("askAdministrator")}
          </RouterLink>
        </>
      )}
    </div>
  );
}
