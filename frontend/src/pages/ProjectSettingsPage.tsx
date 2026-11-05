import { useNavigate, useParams } from "react-router";
import { usePageRoute } from "../navigation";
import ProjectSettings from "../ProjectSettings";
import { useShell, useWorkspace } from "../shell";
import { RouteError } from "./PageStates";

export default function ProjectSettingsPage() {
  const { projectId } = useParams();
  const { section } = usePageRoute();
  const navigate = useNavigate();
  const { refreshWorkspace } = useShell();
  const workspace = useWorkspace();
  const project = workspace.projects.find((p) => p.id === projectId);
  if (!project) return <RouteError />;
  return (
    <ProjectSettings
      key={`${project.id}:${section}`}
      section={section}
      project={project.id}
      workspace={workspace}
      refresh={refreshWorkspace}
      onDeleted={() => void navigate("/projects", { replace: true })}
    />
  );
}
