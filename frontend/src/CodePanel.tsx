import { lazy, Suspense, useEffect, useState } from "react";
import { Download, FileCode2, Loader2, Save } from "lucide-react";
import { downloadProject } from "./api";
import { useT } from "./i18n";
import ProjectFileTree from "./ProjectFileTree";
import { projectFileLanguage } from "./projectFiles";
import type { Snapshot } from "./types";

const CodeEditor = lazy(() => import("./Editor"));
type Draft = { base: Snapshot; files: Record<string, string> };

export default function CodePanel({
  hidden,
  readOnly,
  snapshot,
  onSave,
  onDirtyChange,
}: {
  hidden: boolean;
  readOnly: boolean;
  snapshot: Snapshot;
  onSave: (files: Record<string, string>, base: Snapshot) => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selected, setSelected] = useState("flow.json");
  const [pending, setPending] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const files = draft?.files ?? snapshot.files;
  const path = selected in files ? selected : Object.keys(files).sort()[0];
  const dirty = !!draft;

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const edit = (text: string) => {
    if (!path || readOnly || pending || text === files[path]) return;
    const base = draft?.base ?? snapshot;
    const next = { ...files, [path]: text };
    setDraft(
      Object.keys(next).every((name) => next[name] === base.files[name])
        ? null
        : { base, files: next },
    );
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
                setDraft(null);
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
              if (!draft || pending) return;
              setPending(true);
              setError("");
              try {
                await onSave(draft.files, draft.base);
                setDraft(null);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setPending(false);
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
                {draft && files[path] !== draft.base.files[path] && (
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
