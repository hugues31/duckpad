import DocumentationPanel from "../DocumentationPanel";
import { useLoadedWorktree } from "../worktree";
import { InvalidProject } from "./PageStates";

export default function DocumentationPage() {
  const { snapshot, canEdit, save } = useLoadedWorktree();
  if (!snapshot.bundle) return <InvalidProject />;
  return (
    <DocumentationPanel
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
