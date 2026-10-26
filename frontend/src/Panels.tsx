import { lazy, Suspense, useEffect, useState } from "react";
import {
  AlertCircle,
  ArrowRight,
  Check,
  Clock,
  Database,
  GitBranch,
  GitCommitHorizontal,
  KeyRound,
  Plus,
  Settings2,
  X,
} from "lucide-react";
import { api, send, type Json, type Snapshot, type Workspace } from "./types";
import { useT } from "./i18n";
const CodeEditor = lazy(() => import("./Editor"));
export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const t = useT();
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? "wide" : ""}`}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon" title={t("close")} onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function EditorModal({
  title,
  description,
  value,
  language = "sql",
  onSave,
  onClose,
  readOnly = false,
}: {
  title: string;
  description?: string;
  value: string;
  language?: string;
  onSave?: (v: string) => Promise<void>;
  onClose: () => void;
  readOnly?: boolean;
}) {
  const t = useT();
  const [text, setText] = useState(value);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <Modal title={title} onClose={onClose} wide>
      {description && <p className="modal-description">{description}</p>}
      <Suspense fallback={<p>{t("loading")}</p>}>
        <CodeEditor
          value={text}
          onChange={setText}
          language={language}
          readOnly={readOnly}
          height="460px"
        />
      </Suspense>
      {error && <div className="notice error">{error}</div>}
      <footer>
        <button className="button secondary" onClick={onClose}>
          {t("close")}
        </button>
        {onSave && !readOnly && (
          <button
            className="button primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await onSave(text);
                onClose();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            {t(saving ? "saving" : "save")}
          </button>
        )}
      </footer>
    </Modal>
  );
}
export function FormModal({
  title,
  fields,
  onSubmit,
  onClose,
  description,
}: {
  title: string;
  fields: {
    key: string;
    label: string;
    value?: string;
    multiline?: boolean;
    required?: boolean;
  }[];
  onSubmit: (values: Json) => Promise<void>;
  onClose: () => void;
  description?: string;
}) {
  const t = useT();
  const [values, setValues] = useState<Json>(
    Object.fromEntries(fields.map((f) => [f.key, f.value || ""])),
  );
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setPending(true);
          try {
            await onSubmit(values);
            onClose();
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setPending(false);
          }
        }}
      >
        <div className="modal-content">
          {description && <p className="muted">{description}</p>}
          {fields.map((f) => (
            <label className="field" key={f.key}>
              <span>{f.label}</span>
              {f.multiline ? (
                <textarea
                  rows={5}
                  value={values[f.key]}
                  onChange={(e) =>
                    setValues({ ...values, [f.key]: e.target.value })
                  }
                />
              ) : (
                <input
                  autoFocus={f === fields[0]}
                  required={f.required !== false}
                  value={values[f.key]}
                  onChange={(e) =>
                    setValues({ ...values, [f.key]: e.target.value })
                  }
                />
              )}
            </label>
          ))}
          {error && <div className="notice error">{error}</div>}
        </div>
        <footer>
          <button type="button" className="button secondary" onClick={onClose}>
            {t("cancel")}
          </button>
          <button className="button primary" disabled={pending}>
            {t(pending ? "saving" : "create")}
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function FileModal({
  readOnly = false,
  snapshot,
  onSave,
  onClose,
  title,
  description,
  initialFiles,
}: {
  readOnly?: boolean;
  snapshot: Snapshot;
  onSave: (files: Record<string, string>) => Promise<void>;
  onClose: () => void;
  title?: string;
  description?: string;
  initialFiles?: Record<string, string>;
}) {
  const t = useT();
  const [files, setFiles] = useState(initialFiles || snapshot.files);
  const [selected, setSelected] = useState(Object.keys(files)[0]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  return (
    <Modal title={title || t("rawFiles")} onClose={onClose} wide>
      <p className="modal-description">{description || t("fileHint")}</p>
      <div className="file-editor">
        <nav>
          {Object.keys(files)
            .sort()
            .map((name) => (
              <button
                key={name}
                onClick={() => setSelected(name)}
                className={selected === name ? "active" : ""}
              >
                {name}
              </button>
            ))}
        </nav>
        <Suspense fallback={<p>{t("loading")}</p>}>
          <CodeEditor
            readOnly={readOnly}
            value={files[selected] || ""}
            onChange={(text) => setFiles({ ...files, [selected]: text })}
            language={selected.endsWith(".sql") ? "sql" : "json"}
            height="470px"
          />
        </Suspense>
      </div>
      {error && <div className="notice error">{error}</div>}
      <footer>
        <button className="button secondary" onClick={onClose}>
          {t("cancel")}
        </button>
        <button
          className="button primary"
          disabled={readOnly || pending}
          onClick={async () => {
            setPending(true);
            try {
              await onSave(files);
              onClose();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setPending(false);
            }
          }}
        >
          {t(pending ? "saving" : "save")}
        </button>
      </footer>
    </Modal>
  );
}

export function HistoryPanel({
  readOnly = false,
  worktree,
  onDiff,
  onRevision,
}: {
  readOnly?: boolean;
  worktree: string;
  onDiff: (commit: string) => void;
  onRevision: (commit: string) => void;
}) {
  const t = useT();
  const [tab, setTab] = useState("runs");
  const [runs, setRuns] = useState<Json[]>([]);
  const [commits, setCommits] = useState<Json[]>([]);
  const [selected, setSelected] = useState<Json | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    Promise.all([
      api(`/runs?worktree=${worktree}`),
      api(`/worktrees/${worktree}/history`),
    ])
      .then(([r, c]) => {
        setRuns(r);
        setCommits(c);
      })
      .catch((e) => setError(e.message));
  }, [worktree]);
  return (
    <section className="full-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t("history")}</span>
          <h1>{tab === "runs" ? t("runHistory") : t("gitHistory")}</h1>
        </div>
        <div className="segmented">
          <button
            className={tab === "runs" ? "active" : ""}
            onClick={() => setTab("runs")}
          >
            {t("runHistory")}
          </button>
          <button
            className={tab === "git" ? "active" : ""}
            onClick={() => setTab("git")}
          >
            {t("gitHistory")}
          </button>
        </div>
      </div>
      {error && <p className="notice error">{error}</p>}
      {tab === "runs" ? (
        <>
          <p className="muted">{t("metadataOnly")}</p>
          {!runs.length && (
            <div className="empty-state">
              <Clock />
              <h3>{t("noHistory")}</h3>
            </div>
          )}
          {runs.map((run) => (
            <button
              className="history-row"
              key={run.id}
              onClick={() => setSelected(run)}
            >
              <span className={`history-icon ${run.status}`}>
                {run.status === "success" ? (
                  <Check size={17} />
                ) : run.status === "failed" ||
                  run.status === "partial_failure" ? (
                  <AlertCircle size={17} />
                ) : (
                  <Clock size={17} />
                )}
              </span>
              <span className="grow">
                <strong>
                  {run.scope === "project" ? t("run") : run.scope}
                </strong>
                <small>
                  {new Date(run.started).toLocaleString()} · {run.environment} ·{" "}
                  {run.branch}
                </small>
              </span>
              <span className={`badge ${run.status}`}>{t(run.status)}</span>
              <span>{run.duration?.toFixed(2)} s</span>
              <ArrowRight size={15} />
            </button>
          ))}
        </>
      ) : (
        commits.map((commit) => (
          <div className="history-row" key={commit.commit}>
            <GitCommitHorizontal size={21} />
            <span className="grow">
              <strong>{commit.message}</strong>
              <small>
                {commit.author} · {new Date(commit.date).toLocaleString()} ·{" "}
                {commit.commit.slice(0, 8)}
              </small>
            </span>
            <button
              className="button secondary small"
              onClick={() => onDiff(commit.commit)}
            >
              {t("diff")}
            </button>
            <button
              className="icon"
              title={t("restoreRevision")}
              disabled={readOnly}
              onClick={() => onRevision(commit.commit)}
            >
              <GitBranch size={17} />
            </button>
          </div>
        ))
      )}
      {selected && (
        <Modal title={t("goToRun")} onClose={() => setSelected(null)} wide>
          <div className="modal-content">
            <div className="row gap">
              <span className={`badge ${selected.status}`}>
                {t(selected.status)}
              </span>
              <code>{selected.id}</code>
              <span className="muted">
                {selected.environment} · {selected.commit.slice(0, 8)}
              </span>
            </div>
            {selected.error && <p className="notice error">{selected.error}</p>}
            <details className="run-step">
              <summary>{t("executionConfiguration")}</summary>
              <pre className="expression">
                {JSON.stringify(
                  {
                    commit: selected.commit,
                    environment: selected.environment,
                    scope: selected.scope,
                    trigger: selected.trigger,
                    entry_point: selected.entry_point,
                    started: selected.started,
                    finished: selected.finished,
                    connections: selected.connections,
                    definitions: selected.definitions,
                    components: selected.components,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
            {Object.entries(selected.nodes).map(([key, state]) => (
              <details className="run-step" key={key}>
                <summary>
                  <span className={`badge ${(state as Json).status}`}>
                    {t((state as Json).status)}
                  </span>
                  <strong>{(state as Json).label}</strong>
                  <span className="muted">
                    {(state as Json).duration?.toFixed(3)} s
                  </span>
                </summary>
                {(state as Json).error && (
                  <p className="notice error">{(state as Json).error}</p>
                )}
                {(state as Json).external_outcome && (
                  <p className="notice">
                    {t("externalOutcome")}:{" "}
                    {t((state as Json).external_outcome)}
                  </p>
                )}
                <pre className="expression">
                  {JSON.stringify(state, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        </Modal>
      )}
    </section>
  );
}

export function ConnectionsPanel({
  workspace,
  refresh,
  onEditor,
}: {
  workspace: Workspace;
  refresh: () => Promise<void>;
  onEditor: (data: Json) => void;
}) {
  const t = useT();
  const [selected, setSelected] = useState<Json | null>(null);
  const [env, setEnv] = useState("dev");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const { catalog } = workspace;
  const definition = catalog.connectors.find(
    (c: Json) => c.id === selected?.connector,
  );
  const changeValue = (name: string, value: any) =>
    setSelected((old) => ({
      ...old,
      environments: {
        ...old!.environments,
        [env]: { ...old!.environments?.[env], [name]: value },
      },
    }));
  return (
    <section className="full-panel">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t("workspace")}</span>
          <h1>{t("connections")}</h1>
          <p>{t("catalogHint")}</p>
        </div>
        <button
          className="button primary"
          onClick={() =>
            setSelected({
              id: "",
              name: "",
              connector: "local",
              environments: Object.fromEntries(
                catalog.environments.map((e: string) => [e, {}]),
              ),
            })
          }
        >
          <Plus size={16} />
          {t("newConnection")}
        </button>
      </div>
      <div className="connection-grid">
        {catalog.connections.map((connection: Json) => (
          <button
            key={connection.id}
            className="connection-card"
            onClick={() => {
              setSelected(structuredClone(connection));
              setError("");
            }}
          >
            <span className="connection-logo">
              <Database size={24} />
            </span>
            <strong>{connection.name}</strong>
            <span>
              {catalog.connectors.find(
                (c: Json) => c.id === connection.connector,
              )?.name || connection.connector}
            </span>
            <div className="row gap">
              {Object.keys(connection.environments).map((e) => (
                <span key={e} className="env-badge">
                  {e}
                </span>
              ))}
            </div>
            <Settings2 size={16} className="card-corner" />
          </button>
        ))}
      </div>
      <div className="row spread section-heading">
        <h2>{t("connectorDefinitions")}</h2>
        <button
          className="button secondary small"
          onClick={() =>
            onEditor({
              title: t("newConnector"),
              kind: "connector",
              value: JSON.stringify(
                {
                  id: "custom",
                  name: "Custom connector",
                  description: "",
                  parameters: [{ name: "path", type: "text" }],
                  extensions: [],
                  capabilities: ["read", "write"],
                  init_sql: "",
                  compatibility: "DuckDB >=2.0",
                },
                null,
                2,
              ),
            })
          }
        >
          <Plus size={15} />
          {t("newConnector")}
        </button>
      </div>
      {catalog.connectors.map((connector: Json) => (
        <div className="connector-row" key={connector.id}>
          <div>
            <strong>{connector.name}</strong>
            <p>{connector.description}</p>
            <small>{connector.compatibility}</small>
          </div>
          <div className="row gap">
            {connector.capabilities.map((c: string) => (
              <span key={c} className="badge neutral">
                {t(c)}
              </span>
            ))}
            <button
              className="button secondary small"
              onClick={() =>
                onEditor({
                  title: connector.name,
                  kind: "connector",
                  value: JSON.stringify(connector, null, 2),
                })
              }
            >
              {t("edit")}
            </button>
          </div>
        </div>
      ))}
      {selected && (
        <Modal
          title={selected.name || t("newConnection")}
          onClose={() => setSelected(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setSaving(true);
              try {
                const data = structuredClone(selected);
                for (const environment of Object.keys(data.environments)) {
                  for (const parameter of definition?.parameters || []) {
                    if (
                      data.environments[environment][parameter.name] ===
                        undefined &&
                      parameter.default !== undefined
                    )
                      data.environments[environment][parameter.name] =
                        parameter.default;
                  }
                }
                await api("/catalog/connection", send(data, "PUT"));
                await refresh();
                setSelected(null);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            <div className="modal-content">
              <label className="field">
                <span>ID</span>
                <input
                  required
                  pattern="[a-zA-Z][a-zA-Z0-9_-]*"
                  value={selected.id}
                  onChange={(e) =>
                    setSelected({ ...selected, id: e.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>{t("name")}</span>
                <input
                  required
                  value={selected.name}
                  onChange={(e) =>
                    setSelected({ ...selected, name: e.target.value })
                  }
                />
              </label>
              <label className="field">
                <span>{t("connector")}</span>
                <select
                  value={selected.connector}
                  onChange={(e) =>
                    setSelected({ ...selected, connector: e.target.value })
                  }
                >
                  {catalog.connectors.map((c: Json) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="tabs">
                {catalog.environments.map((e: string) => (
                  <button
                    type="button"
                    key={e}
                    className={e === env ? "active" : ""}
                    onClick={() => setEnv(e)}
                  >
                    {e}
                  </button>
                ))}
              </div>
              {definition?.parameters.map((p: Json) => (
                <label className="field" key={p.name}>
                  <span>
                    {p.secret && <KeyRound size={12} />} {p.name}
                  </span>
                  {p.type === "boolean" ? (
                    <select
                      value={String(
                        selected.environments?.[env]?.[p.name] ??
                          p.default ??
                          false,
                      )}
                      onChange={(e) =>
                        changeValue(p.name, e.target.value === "true")
                      }
                    >
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : (
                    <input
                      type={
                        p.secret
                          ? "password"
                          : p.type === "number"
                            ? "number"
                            : "text"
                      }
                      value={
                        selected.environments?.[env]?.[p.name] ??
                        p.default ??
                        ""
                      }
                      onChange={(e) =>
                        changeValue(
                          p.name,
                          p.type === "number"
                            ? Number(e.target.value)
                            : e.target.value,
                        )
                      }
                    />
                  )}
                </label>
              ))}
              <p className="muted small">{t("secretHint")}</p>
              {error && <div className="notice error">{error}</div>}
            </div>
            <footer>
              <button
                type="button"
                className="button secondary"
                onClick={() => setSelected(null)}
              >
                {t("cancel")}
              </button>
              <button className="button primary" disabled={saving}>
                {t(saving ? "saving" : "save")}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </section>
  );
}

export function DocumentationPanel({
  readOnly = false,
  snapshot,
  onSave,
}: {
  readOnly?: boolean;
  snapshot: Snapshot;
  onSave: (text: string, base: Snapshot) => Promise<void>;
}) {
  const t = useT();
  const [text, setText] = useState(
    snapshot.bundle?.documentation.project || "",
  );
  const [base] = useState(snapshot);
  const [saved, setSaved] = useState("");
  return (
    <section className="full-panel documentation-page">
      <span className="eyebrow">{t("documentation")}</span>
      <h1>{t("projectDocs")}</h1>
      <p className="muted">{t("emptyDocumentation")}</p>
      <textarea
        readOnly={readOnly}
        className="project-documentation"
        value={text}
        placeholder={t("documentationPlaceholder")}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="row gap">
        <button
          className="button primary"
          disabled={readOnly}
          onClick={async () => {
            try {
              await onSave(text, base);
              setSaved(t("saved"));
            } catch (e) {
              setSaved((e as Error).message);
            }
          }}
        >
          {t("save")}
        </button>
        <span className="muted small">{saved}</span>
      </div>
    </section>
  );
}
