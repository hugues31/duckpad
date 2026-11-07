import { useNavigate } from "react-router";
import type { Snapshot } from "../types";
import { api, send } from "../api";
import { useT } from "../i18n";
import { worktreeUrl } from "../navigation";
import { useShell, useWorkspace } from "../shell";
import { declarations } from "../variables";
import VariablesPanel from "../VariablesPanel";
import { useLoadedWorktree } from "../worktree";
import { InvalidProject } from "./PageStates";

export default function VariablesPage() {
  const t = useT();
  const navigate = useNavigate();
  const { openWorktree } = useShell();
  const workspace = useWorkspace();
  const { id, environment, snapshot, canEdit, save, commit, run } =
    useLoadedWorktree();
  if (!snapshot.bundle) return <InvalidProject />;
  return (
    <VariablesPanel
      readOnly={!canEdit}
      onRunSource={canEdit ? (node) => void run(node) : undefined}
      snapshot={snapshot}
      environment={environment}
      environments={workspace.catalog.environment_details}
      onSave={(base, change) =>
        save(base, (bundle) => {
          // A malformed file is corrected in Code, never overwritten from here.
          const variables = declarations(bundle);
          if (!variables) throw new Error(t("invalidVariablesFile"));
          change(variables);
          bundle.variables = variables;
        })
      }
      onRename={async (_base, name, target) => {
        await commit((base) =>
          api<Snapshot>(
            `/worktrees/${id}/variables/${encodeURIComponent(name)}/rename`,
            send({ revision: base.revision, name: target }),
          ),
        );
      }}
      onOpenNode={(node) =>
        void navigate(worktreeUrl(id, "flow", environment, { node }))
      }
      onViewFiles={() => openWorktree(id, "code")}
    />
  );
}
