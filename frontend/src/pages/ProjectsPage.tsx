import { useState } from "react";
import { useProjectCreation } from "../ModalHost";
import ProjectDashboard from "../ProjectDashboard";
import { useShell, useWorkspace } from "../shell";

export default function ProjectsPage() {
  const { notify, openModal } = useShell();
  const workspace = useWorkspace();
  const { createExample } = useProjectCreation();
  const [busy, setBusy] = useState(false);
  return (
    <ProjectDashboard
      projects={workspace.projects}
      busy={busy}
      onCreate={() => openModal({ kind: "newProject" })}
      onExample={async () => {
        setBusy(true);
        try {
          await createExample();
        } catch (e) {
          notify((e as Error).message, true);
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
