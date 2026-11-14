import DocumentationPanel from "../DocumentationPanel";
import { useWorkspace } from "../shell";
import { useLoadedWorktree } from "../worktree";
import { InvalidProject } from "./PageStates";

export default function DocumentationPage() {
  const workspace = useWorkspace();
  const { snapshot, statuses, environment, canEdit, save } =
    useLoadedWorktree();
  if (!snapshot.bundle) return <InvalidProject />;
  return (
    <DocumentationPanel
      statuses={statuses}
      environment={environment}
      environments={workspace.catalog.environment_details}
      readOnly={!canEdit}
      snapshot={snapshot}
      onSave={(text, base) =>
        save(base, (bundle) => {
          bundle.documentation.project = text;
        })
      }
    />
  );
}
