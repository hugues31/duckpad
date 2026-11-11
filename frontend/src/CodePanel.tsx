import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { Download, Loader2, Plus, Save } from "lucide-react";
import { downloadProject } from "./api";
import { codeVariables, nodeCodeContext, savedProblems } from "./codeContext";
import type { CodeContext } from "./codeEditing";
import { nodeLocation, nodeSourcePath } from "./nodeCode";
import { useT } from "./i18n";
import ProjectFileTree from "./ProjectFileTree";
import ProjectFileIcon from "./ProjectFileIcon";
import { CODE_FILE_PARAM } from "./navigation";
import { initialProjectFile, projectFileLanguage } from "./projectFiles";
import { useInputColumns } from "./useInputColumns";
import { useRevisionDraft } from "./useRevisionDraft";
import type { Snapshot } from "./types";
import { useWorktree } from "./worktree";
import { VARIABLES_FILE } from "./variables";

const CodeEditor = lazy(() => import("./Editor"));
type Files = Record<string, string>;

const sameFiles = (a: Files, b: Files) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every((name) => a[name] === b[name]);

export default function CodePanel({
  hidden,
  readOnly,
  snapshot,
  selectedNode,
  onSave,
}: {
  hidden: boolean;
  readOnly: boolean;
  snapshot: Snapshot;
  selectedNode: string;
  /** Save the files on top of the given revision; resolve to the saved snapshot. */
  onSave: (files: Files, base: Snapshot) => Promise<Snapshot>;
}) {
  const t = useT();
  const { setAssistantFile, statuses, environment } = useWorktree();
  // The panel stays mounted across the worktree's tabs.
  const {
    draft: files,
    saved,
    dirty,
    pending,
    update,
    persist,
    discard,
  } = useRevisionDraft(snapshot.files, snapshot, onSave, {
    scope: "worktree",
    equal: sameFiles,
  });
  // The name of the helper module being created, if any.
  const [moduleName, setModuleName] = useState<string | null>(null);
  const [selected, setSelected] = useState(() =>
    initialProjectFile(snapshot, selectedNode),
  );
  const [openedNode, setOpenedNode] = useState<string | null>(null);
  if (!hidden && openedNode !== selectedNode) {
    setOpenedNode(selectedNode);
    setSelected(initialProjectFile(snapshot, selectedNode));
  }
  // A link can open a project file, such as charts.json from the Chart tab.
  const [params, setParams] = useSearchParams();
  const requested = hidden ? null : params.get(CODE_FILE_PARAM);
  if (requested && requested !== selected) setSelected(requested);
  useEffect(() => {
    if (requested)
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete(CODE_FILE_PARAM);
          return next;
        },
        { replace: true },
      );
  }, [requested, setParams]);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const path = selected in files ? selected : Object.keys(files).sort()[0];

  // A root node's own code knows its inputs and values, as in the flow.
  const fileNode = /^nodes\/([^/]+)\.(?:sql|py)$/.exec(path || "")?.[1];
  const node = snapshot.bundle?.flow.nodes.find((n) => n.id === fileNode);
  const columns = useInputColumns(
    snapshot,
    !hidden && node ? node.id : "",
    environment,
    statuses,
  );
  const context = useMemo((): CodeContext | undefined => {
    if (!path) return undefined;
    if (node)
      return nodeCodeContext(
        snapshot,
        node,
        columns.data,
        environment,
        t,
        statuses.nodes[node.id],
      );
    if (/^(?:templates|components\/[^/]+)\/[^/]+\.(?:sql|py)$/.test(path))
      return {
        template: true,
        environment,
        connections: snapshot.connections.map(({ id, name }) => ({ id, name })),
      };
    if (path === "flow.json")
      return {
        file: path,
        environment,
        variables: codeVariables(snapshot, environment),
      };
    return undefined;
  }, [path, node, snapshot, columns.data, environment, t, statuses.nodes]);
  const problems = useMemo(
    () => (path ? savedProblems(snapshot, path, files[path]) : undefined),
    [snapshot, path, files],
  );

  // The failure reported in this saved file, if any.
  const diagnostic = Object.entries(statuses.nodes).flatMap(([id, result]) => {
    const found = result.diagnostic;
    const location =
      found && snapshot.bundle && nodeLocation(snapshot.bundle, id);
    return location &&
      found.source === snapshot.files[path] &&
      nodeSourcePath(location.node, location.parent) === path
      ? [found]
      : [];
  })[0];

  // The server validates the context against saved files; a draft file is not shared.
  const assistantFile = path && path in snapshot.files ? path : "";
  useEffect(() => {
    if (!hidden) setAssistantFile(assistantFile);
  }, [hidden, assistantFile, setAssistantFile]);

  // The SDK is imported as duckpad; a helper module must not shadow it.
  const moduleError = !moduleName
    ? ""
    : !/^[A-Za-z_]\w*(?:\/[A-Za-z_]\w*)*$/.test(moduleName)
      ? t("pythonModuleNameHint")
      : /^duckpad(?:\/|$)/.test(moduleName)
        ? t("pythonModuleReserved")
        : `modules/${moduleName}.py` in files
          ? t("pythonModuleExists")
          : "";

  const edit = (text: string) => {
    if (!path || readOnly || pending || text === files[path]) return;
    update((current) => ({ ...current, [path]: text }));
    setError("");
  };

  return (
    <section className="code-workspace" aria-label={t("code")} hidden={hidden}>
      <header className="code-toolbar">
        <div>
          <strong>{t("files")}</strong>
          <p className="muted">
            {dirty ? t("saveBeforeDownload") : t("fileHint")}
          </p>
        </div>
        <div className="row gap">
          {dirty && (
            <button
              className="button secondary small"
              disabled={pending}
              onClick={() => {
                discard();
                setError("");
              }}
            >
              {t("discardChanges")}
            </button>
          )}
          <button
            className="button primary small"
            disabled={readOnly || !dirty || pending}
            onClick={async () => {
              setError("");
              try {
                await persist();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {pending ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Save size={14} />
            )}
            {t(pending ? "saving" : "save")}
          </button>
          <button
            className="button secondary small"
            disabled={dirty || pending || downloading}
            title={t(dirty ? "saveBeforeDownload" : "downloadProjectHint")}
            onClick={async () => {
              setDownloading(true);
              setError("");
              try {
                await downloadProject(snapshot.worktree.id);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setDownloading(false);
              }
            }}
          >
            {downloading ? (
              <Loader2 size={14} className="spin" />
            ) : (
              <Download size={14} />
            )}
            {t("downloadProject")}
          </button>
        </div>
      </header>
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      <div className="code-layout">
        <aside className="code-files">
          {!readOnly &&
            (!(VARIABLES_FILE in files) || snapshot.python_enabled) && (
              <div className="code-file-actions">
                {!(VARIABLES_FILE in files) && (
                  <button
                    className="button secondary small"
                    disabled={pending}
                    title={t("createVariablesFileHint")}
                    onClick={() => {
                      update((current) => ({
                        ...current,
                        [VARIABLES_FILE]: "{}\n",
                      }));
                      setSelected(VARIABLES_FILE);
                    }}
                  >
                    <Plus size={13} />
                    {t("createVariablesFile")}
                  </button>
                )}
                {snapshot.python_enabled &&
                  (moduleName === null ? (
                    <button
                      className="button secondary small"
                      disabled={pending}
                      onClick={() => setModuleName("")}
                    >
                      <Plus size={13} />
                      {t("pythonCreateModule")}
                    </button>
                  ) : (
                    <form
                      className="field"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (pending || !moduleName || moduleError) return;
                        const name = `modules/${moduleName}.py`;
                        update((current) => ({
                          ...current,
                          [name]: "# Project helper module.\n",
                        }));
                        setSelected(name);
                        setModuleName(null);
                      }}
                    >
                      <label htmlFor="python-module-name">
                        {t("pythonHelperModule")}
                      </label>
                      <input
                        pattern="[A-Za-z_][A-Za-z0-9_]*(/[A-Za-z_][A-Za-z0-9_]*)*"
                        title={t("pythonModuleNameHint")}
                        id="python-module-name"
                        value={moduleName}
                        aria-invalid={!!moduleError}
                        aria-describedby="python-module-name-message"
                        onChange={(event) => setModuleName(event.target.value)}
                        placeholder="helpers"
                        autoFocus
                      />
                      {moduleError ? (
                        <p
                          id="python-module-name-message"
                          role="alert"
                          className="notice error small"
                        >
                          {moduleError}
                        </p>
                      ) : (
                        <p
                          id="python-module-name-message"
                          className="muted small"
                        >
                          {t("pythonModuleNameHint")}
                        </p>
                      )}
                      <div className="row gap">
                        <button
                          className="button primary small"
                          disabled={pending || !moduleName || !!moduleError}
                        >
                          {t("pythonAddModule")}
                        </button>
                        <button
                          type="button"
                          className="button secondary small"
                          onClick={() => setModuleName(null)}
                        >
                          {t("cancel")}
                        </button>
                      </div>
                    </form>
                  ))}
              </div>
            )}
          <ProjectFileTree
            names={snapshot.node_names}
            files={files}
            selected={path}
            onSelect={setSelected}
          />
        </aside>
        <div className="code-editor-column">
          {path ? (
            <>
              <div className="code-file-heading">
                <ProjectFileIcon path={path} />
                <span>{path}</span>
                {files[path] !== saved[path] && (
                  <span className="muted">· {t("unsavedChanges")}</span>
                )}
              </div>
              <div className="code-editor-body">
                {!hidden && (
                  <Suspense fallback={<p>{t("loading")}</p>}>
                    <CodeEditor
                      key={path}
                      value={files[path]}
                      diagnostic={diagnostic}
                      onChange={edit}
                      language={projectFileLanguage(path)}
                      readOnly={readOnly || pending}
                      height="100%"
                      context={context}
                      problems={problems}
                    />
                  </Suspense>
                )}
              </div>
            </>
          ) : (
            <p className="muted">{t("noProjectFiles")}</p>
          )}
        </div>
      </div>
    </section>
  );
}
