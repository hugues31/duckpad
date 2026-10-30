import { useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { Boxes } from "lucide-react";
import { api, ApiError, importProjectArchive, send } from "./api";
import DuckMark from "./DuckMark";
import GitWorkspace from "./GitWorkspace";
import NewProjectModal from "./NewProjectModal";
import NewBranchModal from "./NewBranchModal";
import { useT } from "./i18n";
import { ConfirmModal, EditorModal, FormModal, Modal } from "./modals";
import { usePageRoute } from "./navigation";
import { useShell } from "./shell";
import type { Bundle, Environment, Json, Snapshot } from "./types";
import { useApiResource } from "./useApiResource";
import { useAsyncAction } from "./useAsyncAction";
import { ScopeVariables } from "./VariableFields";
import { conflictLabel } from "./variables";
import { useWorktree } from "./worktree";

const NEW_TEMPLATE = `-- @label Custom transform
-- @input source
-- @output result
SELECT * FROM {{ source }};
`;

/**
 * The open dialog, as plain data. Its actions are built when it renders, so
 * they always use the current session and working branch.
 */
export type ModalState =
  | { kind: "about" }
  | { kind: "newProject" }
  | { kind: "connector"; title: string; value: string }
  | WorktreeModal;

/** Dialogs about one working branch; they never act on another one. */
type WorktreeModal = { worktree: string } & (
  | { kind: "newBranch"; revision?: string }
  | {
      kind: "git";
      mode?: "compare" | "branches" | "sync";
      commit?: string;
      entity?: string;
    }
  | { kind: "runConfirmation"; environment: Environment; node?: string }
  | { kind: "conflict"; conflict: string }
  | { kind: "combinedResolution"; conflict: string }
  | { kind: "template"; template: string; create?: boolean }
  | { kind: "componentDefinition"; component: string }
  /** Group nodes of the graph at `prefix` into a component. */
  | { kind: "group"; nodes: string[]; parent?: string; prefix: string }
  | { kind: "library" }
);

export default function ModalHost({
  modal,
  onClose,
}: {
  modal: ModalState | null;
  onClose: () => void;
}) {
  const { id, snapshot } = useWorktree();
  if (!modal) return null;
  switch (modal.kind) {
    case "about":
      return <AboutDialog onClose={onClose} />;
    case "newProject":
      return <NewProjectDialog onClose={onClose} />;
    case "connector":
      return <ConnectorDialog {...modal} onClose={onClose} />;
  }
  if (modal.worktree !== id || !snapshot) return null;
  return <WorktreeDialog modal={modal} snapshot={snapshot} onClose={onClose} />;
}

/** Create a project, then open its main branch. */
export function useProjectCreation() {
  const { refreshWorkspace, openWorktree } = useShell();
  const created = async <T,>(request: Promise<T>) => {
    const result = await request;
    await refreshWorkspace();
    return result;
  };
  return {
    createEmpty: async (name: string) =>
      openWorktree((await created(api("/projects", send({ name })))).id),
    createExample: async (name?: string) =>
      openWorktree((await created(api("/example", send({ name })))).id),
    importArchive: async (file: File, name: string) => {
      const result = await created(importProjectArchive(file, name));
      return {
        warnings: result.warnings,
        open: () => openWorktree(result.id),
      };
    },
  };
}

function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const creation = useProjectCreation();
  return <NewProjectModal {...creation} onClose={onClose} />;
}

function AboutDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { workspace } = useShell();
  const session = useApiResource<Json>("/session");
  return (
    <Modal title="Duckpad" onClose={onClose}>
      <div className="modal-content">
        <DuckMark size={48} />
        <p>{t("aboutText")}</p>
        <code>
          DuckDB {workspace?.catalog.duckdb_version || ""} · Duckpad{" "}
          {session.data?.version || session.error}
        </code>
      </div>
    </Modal>
  );
}

function ConnectorDialog({
  title,
  value,
  onClose,
}: {
  title: string;
  value: string;
  onClose: () => void;
}) {
  const { refreshWorkspace } = useShell();
  const save = async (text: string) => {
    await api("/catalog/connector", send(JSON.parse(text), "PUT"));
    await refreshWorkspace();
  };
  return (
    <EditorModal
      title={title}
      value={value}
      language="json"
      onClose={onClose}
      onSave={save}
    />
  );
}

function WorktreeDialog({
  modal,
  snapshot,
  onClose,
}: {
  modal: WorktreeModal;
  snapshot: Snapshot;
  onClose: () => void;
}) {
  const t = useT();
  const { openModal, openWorktree } = useShell();
  const { tab } = usePageRoute();
  const { canEdit, gitChanged, runConfirmed } = useWorktree();
  switch (modal.kind) {
    case "newBranch":
      return (
        <NewBranchDialog
          worktree={modal.worktree}
          branch={snapshot.worktree.branch}
          revision={modal.revision}
          onClose={onClose}
        />
      );
    case "git":
      return (
        <GitWorkspace
          worktree={modal.worktree}
          role={snapshot.role}
          mode={modal.mode}
          commit={modal.commit}
          entity={modal.entity}
          onClose={onClose}
          onChanged={gitChanged}
          onOpen={(id) => openWorktree(id, tab)}
          onNewBranch={() =>
            openModal({ kind: "newBranch", worktree: modal.worktree })
          }
        />
      );
    case "runConfirmation":
      return (
        <ConfirmModal
          title={t("confirmRun")}
          confirmLabel={t("confirmAndRun")}
          onConfirm={() => runConfirmed(modal.environment.id, modal.node)}
          onClose={onClose}
        >
          <div className="row gap">
            <span
              className="env-dot"
              style={{ background: modal.environment.color }}
            />
            <strong>{modal.environment.label}</strong>
            <code>{modal.environment.id}</code>
          </div>
          <p>{t("confirmRunHint")}</p>
          <p>
            {snapshot.bundle?.flow.name || ""} · {snapshot.worktree.branch} ·{" "}
            {modal.node || t("run")}
          </p>
          <ScopeVariables
            worktree={modal.worktree}
            environment={modal.environment.id}
            node={modal.node}
          />
        </ConfirmModal>
      );
    case "conflict":
    case "combinedResolution": {
      const conflict = snapshot.conflicts.find(
        (item) => item.id === modal.conflict,
      );
      if (!conflict) return null;
      return modal.kind === "conflict" ? (
        <ConflictDialog conflict={conflict} onClose={onClose} />
      ) : (
        <CombinedResolutionDialog conflict={conflict} onClose={onClose} />
      );
    }
    case "template":
      return (
        <RevisionEditor
          snapshot={snapshot}
          title={t(modal.create ? "newTemplate" : "editTemplate")}
          description={modal.create ? undefined : t("sharedTemplateHint")}
          readOnly={!canEdit}
          read={(bundle) =>
            modal.create ? NEW_TEMPLATE : bundle.templates[modal.template]
          }
          write={(bundle, text) => {
            bundle.templates[modal.template] = text;
          }}
          onClose={onClose}
        />
      );
    case "componentDefinition":
      return (
        <RevisionEditor
          snapshot={snapshot}
          title={t("definition")}
          description={t("sharedTemplateHint")}
          language="json"
          readOnly={!canEdit}
          read={(bundle) =>
            JSON.stringify(bundle.components[modal.component], null, 2)
          }
          write={(bundle, text) => {
            bundle.components[modal.component] = JSON.parse(text);
          }}
          onClose={onClose}
        />
      );
    case "group":
      return <GroupDialog {...modal} snapshot={snapshot} onClose={onClose} />;
    case "library":
      return <LibraryDialog snapshot={snapshot} onClose={onClose} />;
  }
}

function NewBranchDialog({
  worktree,
  branch,
  revision,
  onClose,
}: {
  worktree: string;
  branch: string;
  revision?: string;
  onClose: () => void;
}) {
  const t = useT();
  const { refreshWorkspace, notify, openWorktree } = useShell();
  const { tab } = usePageRoute();
  const create = async (name: string, startingRevision?: string) => {
    const next = await api(
      `/worktrees/${worktree}/branches`,
      send({ name, revision: startingRevision }),
    ).catch((error) => {
      if (
        error instanceof ApiError &&
        (error.detail as Json)?.code === "invalid_branch_name"
      )
        throw new Error(t("invalidBranchName"));
      throw error;
    });
    await refreshWorkspace();
    openWorktree(next.id, tab);
    notify(t("branchCreated"));
  };
  return (
    <NewBranchModal
      worktree={worktree}
      branch={branch}
      revision={revision}
      onClose={onClose}
      submit={create}
    />
  );
}

/** Edit a text of the bundle; saving applies it to the revision shown when the dialog opened. */
function RevisionEditor({
  snapshot,
  read,
  write,
  ...props
}: {
  snapshot: Snapshot;
  title: string;
  description?: string;
  language?: string;
  readOnly: boolean;
  read: (bundle: Bundle) => string;
  write: (bundle: Bundle, text: string) => void;
  onClose: () => void;
}) {
  const { save } = useWorktree();
  const [base] = useState(snapshot);
  return (
    <EditorModal
      {...props}
      value={read(base.bundle!)}
      onSave={async (text) => {
        await save(base, (bundle) => write(bundle, text));
      }}
    />
  );
}

function ConflictDialog({
  conflict,
  onClose,
}: {
  conflict: Json;
  onClose: () => void;
}) {
  const t = useT();
  const { openModal } = useShell();
  const { id, refresh } = useWorktree();
  const { pending, error, run } = useAsyncAction();
  const choose = async (choice: "current" | "proposal") => {
    const resolved = await run(async () => {
      await api(`/conflicts/${conflict.id}/resolve`, send({ choice }));
      await refresh();
    });
    if (resolved) onClose();
  };
  return (
    <Modal title={t("conflict")} onClose={onClose} wide>
      <div className="modal-content">
        <p>{t("conflictHint")}</p>
        <pre className="expression">
          {conflict.paths
            .map((path: string) => conflictLabel(path, t) || path)
            .join("\n")}
        </pre>
        <div className="conflict-comparison">
          <div>
            <h4>{t("keepCurrent")}</h4>
            <pre>{JSON.stringify(conflict.current, null, 2)}</pre>
          </div>
          <div>
            <h4>{t("keepProposal")}</h4>
            <pre>{JSON.stringify(conflict.proposal, null, 2)}</pre>
          </div>
        </div>
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
      </div>
      <footer>
        <button
          className="button secondary"
          disabled={pending}
          onClick={() =>
            openModal({
              kind: "combinedResolution",
              worktree: id,
              conflict: conflict.id,
            })
          }
        >
          {t("combined")}
        </button>
        {(["current", "proposal"] as const).map((choice) => (
          <button
            key={choice}
            className={`button ${choice === "proposal" ? "primary" : "secondary"}`}
            disabled={pending}
            onClick={() => choose(choice)}
          >
            {t(choice === "current" ? "keepCurrent" : "keepProposal")}
          </button>
        ))}
      </footer>
    </Modal>
  );
}

function CombinedResolutionDialog({
  conflict,
  onClose,
}: {
  conflict: Json;
  onClose: () => void;
}) {
  const t = useT();
  const { refresh } = useWorktree();
  const resolve = async (text: string) => {
    await api(
      `/conflicts/${conflict.id}/resolve`,
      send({ choice: "combined", files: JSON.parse(text) }),
    );
    await refresh();
  };
  return (
    <EditorModal
      title={t("combined")}
      language="json"
      value={JSON.stringify(conflict.proposal, null, 2)}
      onClose={onClose}
      onSave={resolve}
    />
  );
}

function GroupDialog({
  nodes,
  parent,
  prefix,
  snapshot,
  onClose,
}: {
  nodes: string[];
  parent?: string;
  prefix: string;
  snapshot: Snapshot;
  onClose: () => void;
}) {
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const { id, refresh } = useWorktree();
  const [base] = useState(snapshot);
  const group = async (values: Json) => {
    const result = await api(
      `/worktrees/${id}/group`,
      send({
        revision: base.revision,
        nodes,
        parent,
        name: values.name,
        parameters: JSON.parse(values.parameters || "{}"),
      }),
    );
    await refresh();
    // Select the new component the way the flow reveals search results.
    const search = new URLSearchParams(location.search);
    search.set("node", prefix + result.selected);
    void navigate({ search: `?${search}` }, { replace: true });
  };
  return (
    <FormModal
      title={t("group")}
      fields={[
        { key: "name", label: t("groupName") },
        {
          key: "parameters",
          label: t("exposedParameters"),
          value: "{}",
          multiline: true,
          required: false,
        },
      ]}
      description={t("exposedHint")}
      onClose={onClose}
      onSubmit={group}
    />
  );
}

function LibraryDialog({
  snapshot,
  onClose,
}: {
  snapshot: Snapshot;
  onClose: () => void;
}) {
  const t = useT();
  const { notify } = useShell();
  const { id, refresh } = useWorktree();
  const library = useApiResource<Json[]>("/library");
  const { pending, error, run } = useAsyncAction();
  // A double click must not import two copies.
  const importing = useRef(false);
  const items = (library.data || []).filter(
    (item) => item.project !== snapshot.worktree.project,
  );
  const importItem = async (item: Json) => {
    if (importing.current) return;
    importing.current = true;
    const imported = await run(async () => {
      await api(
        `/worktrees/${id}/import`,
        send({
          revision: snapshot.revision,
          source_worktree: item.worktree,
          kind: item.kind,
          id: item.id,
        }),
      );
      await refresh();
    });
    importing.current = false;
    if (imported) notify(t("importComplete"));
  };
  return (
    <Modal title={t("library")} onClose={onClose} wide>
      <div className="modal-content">
        <p className="muted">{t("importHint")}</p>
        {library.pending ? (
          <p>{t("loading")}</p>
        ) : library.error ? (
          <div className="notice error" role="alert">
            {library.error}
          </div>
        ) : (
          !items.length && <p>{t("emptyLibrary")}</p>
        )}
        {error && (
          <div className="notice error" role="alert">
            {error}
          </div>
        )}
        {items.map((item) => (
          <div className="history-row" key={item.project + item.kind + item.id}>
            <Boxes size={18} />
            <span className="grow">
              <strong>{item.name}</strong>
              <small>
                {item.project_name} · {item.kind}
              </small>
            </span>
            <button
              className="button secondary small"
              disabled={pending}
              onClick={() => importItem(item)}
            >
              {t("import")}
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}
