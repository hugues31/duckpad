import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Boxes,
  Code2,
  FileUp,
  Play,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import {
  api,
  send,
  type Json,
  type FlowNode,
  type FlowEdge,
  type Snapshot,
} from "./types";
import { useT } from "./i18n";
import QueryBuilder from "./QueryBuilder";
const CodeEditor = lazy(() => import("./Editor"));

export function ParameterField({
  parameter,
  value,
  onChange,
  onBlur,
  connections,
  schemas,
}: {
  parameter: Json;
  value: any;
  onChange: (value: any) => void;
  onBlur?: () => void;
  connections: Json[];
  schemas?: string[];
}) {
  const t = useT();
  const name = parameter.name;
  const type = parameter.type || "text";
  const base = type.split(/[<(]/)[0];
  if (base === "secret") return null;
  return (
    <label className="field">
      <span>
        {name.replaceAll("_", " ")}
        <small>{base}</small>
      </span>
      {base === "boolean" ? (
        <select
          value={String(value ?? false)}
          onChange={(e) => onChange(e.target.value === "true")}
          onBlur={onBlur}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : base === "connection" ? (
        <select
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        >
          {!value && <option value="">{t("notConnected")}</option>}
          {value && !connections.some((c) => c.id === value) && (
            <option value={value} disabled>
              {value} · {t("unavailableConnection")}
            </option>
          )}
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      ) : base === "choice" || base === "keyword" ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        >
          {(type.match(/\((.*)\)/)?.[1] || "").split("|").map((x: string) => (
            <option key={x}>{x}</option>
          ))}
        </select>
      ) : base === "list" ? (
        <input
          value={Array.isArray(value) ? value.join(", ") : value || ""}
          onChange={(e) =>
            onChange(e.target.value.split(",").map((x) => x.trim()))
          }
          onBlur={onBlur}
        />
      ) : base === "expressions" ||
        base === "expression" ||
        base === "schema" ? (
        <textarea
          rows={3}
          className="code-input"
          value={
            typeof value === "object"
              ? JSON.stringify(value, null, 2)
              : (value ?? "")
          }
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        />
      ) : (
        <input
          type={base === "number" ? "number" : "text"}
          value={value ?? ""}
          onChange={(e) =>
            onChange(
              base === "number" ? Number(e.target.value) : e.target.value,
            )
          }
          onBlur={onBlur}
          list={base === "column" ? "input-columns" : undefined}
        />
      )}
      {base === "file" && (
        <span className="file-upload">
          <FileUp size={13} />
          {t("upload")}
          <input
            type="file"
            accept=".csv,.parquet,.tsv"
            aria-label={t("upload")}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const form = new FormData();
              form.append("file", file);
              const response = await fetch("/api/uploads", {
                method: "POST",
                body: form,
              });
              const result = await response.json();
              if (response.ok) {
                onChange(result.path);
              }
            }}
          />
        </span>
      )}
      {schemas && (
        <datalist id="input-columns">
          {schemas.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </label>
  );
}

export default function Inspector({
  node,
  definition,
  snapshot,
  graphNodes,
  graphEdges,
  fullNode,
  environment,
  connections,
  status,
  preview,
  onSave,
  onInput,
  onDelete,
  onRun,
  onOpen,
  onEditTemplate,
  onClose,
}: {
  node: FlowNode;
  definition: Json;
  snapshot: Snapshot;
  graphNodes: FlowNode[];
  graphEdges: FlowEdge[];
  fullNode: string;
  environment: string;
  connections: Json[];
  status: Json;
  preview: Json | null;
  onSave: (node: FlowNode, base: Snapshot) => Promise<void>;
  onInput: (port: string, source: string) => void;
  onDelete: () => void;
  onRun: () => void;
  onOpen: () => void;
  onEditTemplate: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [tab, setTab] = useState("parameters");
  const [draft, setDraft] = useState(node);
  const dirty = useRef(false);
  const base = useRef(snapshot);
  const draftRef = useRef(node);
  const [sqlMode, setSqlMode] = useState("current");
  const [compiled, setCompiled] = useState<Json[]>([]);
  const [error, setError] = useState("");
  const [schemas, setSchemas] = useState<Record<string, string[]>>({});
  useEffect(() => {
    let live = true;
    const prefix = fullNode.includes("::")
      ? fullNode.slice(0, fullNode.lastIndexOf("::") + 2)
      : "";
    Promise.all(
      graphEdges
        .filter((e) => e.target === node.id)
        .map(async (edge) => {
          try {
            const result = await api(
              `/worktrees/${snapshot.worktree.id}/preview/${encodeURIComponent(prefix + edge.source)}?environment=${environment}&port=${edge.sourceHandle}&limit=1`,
            );
            return [
              edge.targetHandle,
              result.columns.map((c: Json) => c.name),
            ] as const;
          } catch {
            return [edge.targetHandle, []] as const;
          }
        }),
    ).then((entries) => {
      if (live) setSchemas(Object.fromEntries(entries));
    });
    return () => {
      live = false;
    };
  }, [graphEdges, fullNode, environment, status, snapshot.worktree.id]);
  useEffect(() => {
    if (!dirty.current) {
      setDraft(node);
      draftRef.current = node;
      base.current = snapshot;
    }
  }, [node, snapshot]);
  const update = (patch: Partial<FlowNode>) => {
    if (!dirty.current) base.current = snapshot;
    dirty.current = true;
    draftRef.current = { ...draftRef.current, ...patch };
    setDraft(draftRef.current);
  };
  const persist = async () => {
    if (dirty.current) {
      try {
        await onSave(draftRef.current, base.current);
        dirty.current = false;
      } catch (e) {
        setError((e as Error).message);
      }
    }
  };
  useEffect(() => {
    if (tab === "sql" && sqlMode === "current") {
      setError("");
      api(
        `/worktrees/${snapshot.worktree.id}/compile/${encodeURIComponent(fullNode)}?environment=${environment}`,
      )
        .then(setCompiled)
        .catch((e) => setError(e.message));
    }
  }, [tab, sqlMode, snapshot.revision, fullNode, environment]);
  const parameters = node.component
    ? Object.entries(definition.parameters || {}).map(([name, p]) => ({
        ...(p as Json),
        name,
      }))
    : definition.parameters || [];
  const inputs = node.component
    ? Object.keys(definition.inputs || {})
    : definition.inputs || [];
  const statements: Json[] =
    sqlMode === "executed" ? preview?.executed_sql || [] : compiled;
  return (
    <aside className="inspector">
      <div className="inspector-title">
        <span>{node.label || definition.name || definition.label}</span>
        <button className="icon" onClick={onClose} title={t("close")}>
          <X size={18} />
        </button>
      </div>
      <div className="inspector-kind">
        <span className={`kind-icon ${node.component ? "component" : ""}`}>
          {node.component ? <Boxes size={18} /> : <Settings2 size={18} />}
        </span>
        <div>
          <strong>
            {t(node.component ? "component" : definition.kind || "transform")}
          </strong>
          <small>{node.template || node.component}</small>
        </div>
        <button
          className="icon run-node"
          title={t("runNode")}
          disabled={!!status.active}
          onClick={onRun}
        >
          <Play size={16} />
        </button>
      </div>
      <div className="tabs inspector-tabs">
        {[
          ["parameters", Settings2],
          ["sql", Code2],
          ["notes", BookOpen],
        ].map(([key, Icon]) => (
          <button
            key={key as string}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key as string)}
          >
            <Icon size={14} />
            {t(key as string)}
          </button>
        ))}
      </div>
      <div className="inspector-body">
        {error && <div className="notice error">{error}</div>}
        {tab === "parameters" ? (
          <>
            <label className="field">
              <span>{t("nodeLabel")}</span>
              <input
                value={draft.label || ""}
                onChange={(e) => update({ label: e.target.value })}
                onBlur={persist}
              />
            </label>
            {node.component && (
              <>
                <p className="muted small">{t("sharedTemplateHint")}</p>
                <button className="button secondary full" onClick={onOpen}>
                  <Boxes size={15} />
                  {t("openComponent")}
                  <ArrowRight size={15} />
                </button>
              </>
            )}
            {!!inputs.length && (
              <>
                <h4>{t("inputs")}</h4>
                {inputs.map((port: string) => {
                  const edge = graphEdges.find(
                    (e) => e.target === node.id && e.targetHandle === port,
                  );
                  return (
                    <label className="field" key={port}>
                      <span>{port}</span>
                      <select
                        aria-label={port}
                        value={
                          edge ? `${edge.source}:${edge.sourceHandle}` : ""
                        }
                        onChange={(e) => onInput(port, e.target.value)}
                      >
                        <option value="">{t("notConnected")}</option>
                        {graphNodes
                          .filter((n) => n.id !== node.id)
                          .flatMap((n) => {
                            const def = n.component
                              ? snapshot.bundle!.components[n.component]
                              : snapshot.parsed_templates[n.template || ""];
                            const ports = n.component
                              ? Object.keys(def?.outputs || {})
                              : def?.outputs || [];
                            return ports.map((p: string) => (
                              <option
                                key={n.id + ":" + p}
                                value={n.id + ":" + p}
                              >
                                {n.label || n.id} · {p}
                              </option>
                            ));
                          })}
                      </select>
                    </label>
                  );
                })}
              </>
            )}
            {!!parameters.length && <h4>{t("parameters")}</h4>}
            <QueryBuilder
              kind={node.template || ""}
              schemas={schemas}
              onApply={(values) =>
                update({ params: { ...draftRef.current.params, ...values } })
              }
            />
            {parameters.map((parameter: Json) => (
              <ParameterField
                key={parameter.name}
                parameter={parameter}
                value={draft.params?.[parameter.name] ?? parameter.default}
                onChange={(value) =>
                  update({
                    params: {
                      ...draftRef.current.params,
                      [parameter.name]: value,
                    },
                  })
                }
                onBlur={persist}
                connections={connections}
                schemas={
                  schemas[parameter.type?.match(/\((\w+)\)/)?.[1]] ||
                  Object.values(schemas).flat()
                }
              />
            ))}
            <button className="button primary full" onClick={persist}>
              {t("save")}
            </button>
            {!node.component && (
              <button
                className="button secondary full"
                onClick={onEditTemplate}
              >
                <Code2 size={15} />
                {t("editTemplate")}
              </button>
            )}
            <div className="inspector-danger">
              <button className="text-button danger" onClick={onDelete}>
                <Trash2 size={14} />
                {t("deleteNode")}
              </button>
            </div>
          </>
        ) : tab === "sql" ? (
          <>
            <div className="segmented">
              <button
                className={sqlMode === "current" ? "active" : ""}
                onClick={() => setSqlMode("current")}
              >
                {t("currentSql")}
              </button>
              <button
                className={sqlMode === "executed" ? "active" : ""}
                onClick={() => setSqlMode("executed")}
              >
                {t("executedSql")}
              </button>
            </div>
            <p className="muted small">
              {sqlMode === "current"
                ? t("compileHint")
                : preview
                  ? `${t("commit")} ${preview.commit.slice(0, 8)}`
                  : t("noResultHint")}
            </p>
            <Suspense fallback={<p>{t("loading")}</p>}>
              <CodeEditor
                value={statements
                  .map((s) =>
                    sqlMode === "executed" && s.materialization_sql
                      ? s.materialization_sql.join(";\n") + ";"
                      : s.sql + ";",
                  )
                  .join("\n\n")}
                readOnly
                height="330px"
              />
            </Suspense>
            {statements.some(
              (s) => Object.keys(s.bindings || {}).length > 0,
            ) && (
              <>
                <h4>{t("bindings")}</h4>
                <pre className="expression">
                  {JSON.stringify(
                    Object.assign({}, ...statements.map((s) => s.bindings)),
                    null,
                    2,
                  )}
                </pre>
              </>
            )}
          </>
        ) : (
          <NodeDocumentation
            node={node}
            snapshot={snapshot}
            fullNode={fullNode}
            preview={preview}
          />
        )}
      </div>
    </aside>
  );
}

function NodeDocumentation({
  snapshot,
  fullNode,
  preview,
}: {
  node: FlowNode;
  snapshot: Snapshot;
  fullNode: string;
  preview: Json | null;
}) {
  const t = useT();
  const [kind, setKind] = useState("nodes");
  const [column, setColumn] = useState("");
  const key =
    kind === "nodes" ? fullNode : fullNode + ":" + (preview?.port || "result");
  const current =
    kind === "columns"
      ? snapshot.bundle?.documentation.columns?.[key]?.[column] || ""
      : snapshot.bundle?.documentation[kind]?.[key] || "";
  const [value, setValue] = useState(current);
  const [message, setMessage] = useState("");
  const base = useRef(snapshot);
  useEffect(() => {
    setValue(current);
    base.current = snapshot;
  }, [kind, column, key, current]);
  async function save() {
    try {
      const bundle = structuredClone(base.current.bundle!);
      bundle.documentation[kind] ??= {};
      if (kind === "columns") {
        bundle.documentation.columns[key] ??= {};
        bundle.documentation.columns[key][column] = value;
      } else bundle.documentation[kind][key] = value;
      await api(
        `/worktrees/${snapshot.worktree.id}`,
        send({ revision: base.current.revision, bundle }, "PUT"),
      );
      setMessage(t("saved"));
    } catch (e) {
      setMessage((e as Error).message);
    }
  }
  return (
    <>
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        aria-label={t("documentation")}
      >
        <option value="nodes">{t("nodeDocs")}</option>
        <option value="datasets">{t("datasetDocs")}</option>
        <option value="columns">{t("columnDocs")}</option>
      </select>
      {kind === "columns" && (
        <select
          value={column}
          onChange={(e) => setColumn(e.target.value)}
          aria-label={t("chooseColumn")}
        >
          <option value="">{t("chooseColumn")}</option>
          {preview?.columns.map((c: Json) => (
            <option key={c.name}>{c.name}</option>
          ))}
        </select>
      )}
      <textarea
        className="documentation-editor"
        value={value}
        placeholder={t("documentationPlaceholder")}
        onChange={(e) => setValue(e.target.value)}
      />
      <button
        className="button primary full"
        onClick={save}
        disabled={kind === "columns" && !column}
      >
        {t("save")}
      </button>
      {message && <p className="muted small">{message}</p>}
    </>
  );
}
