import InstanceSettings from "../InstanceSettings";
import { usePageRoute } from "../navigation";
import { useShell, useWorkspace } from "../shell";
import { RouteError } from "./PageStates";

export default function InstanceSettingsPage() {
  const { section } = usePageRoute();
  const { refreshWorkspace, openModal } = useShell();
  const workspace = useWorkspace();
  if (workspace.user.role !== "admin") return <RouteError />;
  return (
    <InstanceSettings
      key={section}
      section={section!}
      workspace={workspace}
      refresh={async () => {
        await refreshWorkspace();
      }}
      onConnectorEditor={(editor) =>
        openModal({ kind: "connector", ...editor })
      }
    />
  );
}
