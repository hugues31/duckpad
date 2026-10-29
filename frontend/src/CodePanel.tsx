import { lazy, Suspense, useState } from "react";
import { Download, FileCode2, Loader2, Save } from "lucide-react";
import { downloadProject } from "./api";
import { useT } from "./i18n";
import ProjectFileTree from "./ProjectFileTree";
import { projectFileLanguage } from "./projectFiles";
import { useRevisionDraft } from "./useRevisionDraft";
import type { Snapshot } from "./types";

const CodeEditor = lazy(() => import("./Editor"));
type Files = Record<string, string>;

const sameFiles = (a: Files, b: Files) =>
  Object.keys(a).length === Object.keys(b).length &&
  Object.keys(a).every((name) => a[name] === b[name]);

export default function CodePanel({
  hidden,
  readOnly,
  snapshot,
  onSave,
}: {
  hidden: boolean;
  readOnly: boolean;
  snapshot: Snapshot;
  /** Save the files on top of the given revision; resolve to the saved snapshot. */
  onSave: (files: Files, base: Snapshot) => Promise<Snapshot>;
}) {
  const t = useT();
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
  const [selected, setSelected] = useState("flow.json");
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const path = selected in files ? selected : Object.keys(files).sort()[0];

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
          <ProjectFileTree
            files={files}
            selected={path}
            onSelect={setSelected}
          />
        </aside>
        <div className="code-editor-column">
          {path ? (
            <>
              <div className="code-file-heading">
                <FileCode2 size={15} />
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
                      onChange={edit}
                      language={projectFileLanguage(path)}
                      readOnly={readOnly || pending}
                      height="100%"
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
