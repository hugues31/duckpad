import { useLocation, useNavigate } from "react-router";
import { api, send } from "../api";
import InstanceSettings from "../InstanceSettings";
import { usePageRoute } from "../navigation";
import { useShell, useWorkspace } from "../shell";
import { RouteError } from "./PageStates";

export default function InstanceSettingsPage() {
  const { section } = usePageRoute();
  const { refreshWorkspace, openModal } = useShell();
  const workspace = useWorkspace();
  const { search } = useLocation();
  const navigate = useNavigate();
  const query = new URLSearchParams(search);
  const returnWorktree = workspace.worktrees.find(
    (worktree) =>
      worktree.id === query.get("worktree") &&
      worktree.project === query.get("project"),
  );
  if (workspace.user.role !== "admin") return <RouteError />;
  return (
    <InstanceSettings
      key={section}
      section={section!}
      workspace={workspace}
      refresh={async () => {
        await refreshWorkspace();
      }}
      onConnectionCreated={
        returnWorktree
          ? async (connection) => {
              const settings = await api<{ connections: string[] }>(
                `/projects/${returnWorktree.project}/settings`,
              );
              await api(
                `/projects/${returnWorktree.project}/connections`,
                send(
                  {
                    connections: [
                      ...new Set([...settings.connections, connection.id]),
                    ],
                  },
                  "PUT",
                ),
              );
              await refreshWorkspace();
              navigate(
                `/worktrees/${returnWorktree.id}/flow?node=${encodeURIComponent(query.get("node") || "")}`,
              );
            }
          : undefined
      }
      onConnectorEditor={(editor) =>
        openModal({ kind: "connector", ...editor })
      }
    />
  );
}
