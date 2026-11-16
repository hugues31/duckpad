import { useState } from "react";
import { useProjectCreation } from "../ModalHost";
import ProjectDashboard from "../ProjectDashboard";
import { useShell, useWorkspace } from "../shell";
import { useApiResource } from "../useApiResource";
import type { Project } from "../types";

export default function ProjectsPage() {
  const { notify, openModal } = useShell();
  const workspace = useWorkspace();
  const { createExample } = useProjectCreation();
  const [busy, setBusy] = useState(false);
  // Loaded per visit: dates cost a git call per project.
  const activity = useApiResource<Project[]>("/projects", {
    refresh: workspace.projects.map((item) => item.id).join(","),
  });
  return (
    <ProjectDashboard
      projects={workspace.projects.map((project) => {
        const item = activity.data?.find((item) => item.id === project.id);
        return { ...project, updated: item?.updated, last_run: item?.last_run };
      })}
      activityError={activity.error}
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
