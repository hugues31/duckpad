import Select from "./Select";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  BookOpen,
  Boxes,
  Code2,
  Play,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { api, withQuery } from "./api";
import { definitionOf, outputPorts } from "./graph";
import { useT } from "./i18n";
import NodeDocumentation from "./NodeDocumentation";
import ExportDownload from "./ExportDownload";
import ParameterField from "./ParameterField";
import QueryBuilder from "./QueryBuilder";
import type { FlowEdge, FlowNode, Json, Snapshot, Statuses } from "./types";

const CodeEditor = lazy(() => import("./Editor"));

const TABS = [
  ["parameters", Settings2],
  ["sql", Code2],
  ["notes", BookOpen],
] as const;

export default function Inspector({
  readOnly = false,
  node,
  definition,
  snapshot,
  graphNodes,
  graphEdges,
  fullNode,
  environment,
  connections,
  statuses,
  preview,
  onSave,
  onSaveDocumentation,
  onInput,
  onDelete,
  onRun,
  onOpen,
  onEditTemplate,
  onHistory,
  onClose,
}: {
  readOnly?: boolean;
  node: FlowNode;
  definition: Json;
  snapshot: Snapshot;
  graphNodes: FlowNode[];
  graphEdges: FlowEdge[];
  fullNode: string;
  environment: string;
  connections: Json[];
  statuses: Statuses;
  preview: Json | null;
  onSave: (node: FlowNode, base: Snapshot) => Promise<void>;
  onSaveDocumentation: (
    change: (documentation: Json) => void,
    base: Snapshot,
  ) => Promise<void>;
  onInput: (port: string, source: string) => void;
  onDelete: () => void;
  onRun: () => void;
  onOpen: () => void;
  onEditTemplate: () => void;
  onHistory: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("parameters");
  const [draft, setDraft] = useState(node);
  const dirty = useRef(false);
  const base = useRef(snapshot);
  const draftRef = useRef(node);
  const [sqlMode, setSqlMode] = useState<"current" | "executed">("current");
  const [compiled, setCompiled] = useState<Json[]>([]);
  const [error, setError] = useState("");
  const [inputColumns, setInputColumns] = useState<Record<string, Json[]>>({});
  const schemas = Object.fromEntries(
    Object.entries(inputColumns).map(([port, columns]) => [
      port,
      columns.map((column) => column.name as string),
    ]),
  );
  // Column suggestions come from the materialized inputs; refresh them when results change.
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
              withQuery(
                `/worktrees/${snapshot.worktree.id}/preview/${encodeURIComponent(prefix + edge.source)}`,
                { environment, port: edge.sourceHandle, limit: 1 },
              ),
            );
            return [edge.targetHandle, result.columns as Json[]] as const;
          } catch {
            return [edge.targetHandle, []] as const;
          }
        }),
    ).then((entries) => {
      if (live) setInputColumns(Object.fromEntries(entries));
    });
    return () => {
      live = false;
    };
  }, [graphEdges, fullNode, environment, statuses, snapshot.worktree.id]);
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
    if (dirty.current && !readOnly) {
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
      let live = true;
      api(
        withQuery(
          `/worktrees/${snapshot.worktree.id}/compile/${encodeURIComponent(fullNode)}`,
          { environment },
        ),
      )
        .then((statements) => {
          if (live) setCompiled(statements);
        })
        .catch((e) => {
          if (live) setError(e.message);
        });
      return () => {
        live = false;
      };
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
          disabled={readOnly || !!statuses.active}
          onClick={onRun}
        >
          <Play size={16} />
        </button>
      </div>
      <button className="button secondary small" onClick={onHistory}>
        {t("elementHistory")}
      </button>
      {definition.kind === "export" &&
        ["export_csv", "export_xlsx"].includes(node.template || "") && (
          <ExportDownload
            key={`${snapshot.worktree.id}:${environment}:${fullNode}:${snapshot.revision}`}
            worktree={snapshot.worktree.id}
            environment={environment}
            node={fullNode}
          />
        )}
      <div className="tabs inspector-tabs">
        {TABS.map(([key, Icon]) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            aria-pressed={tab === key}
            onClick={() => setTab(key)}
          >
            <Icon size={14} />
            {t(key)}
          </button>
        ))}
      </div>
      <div className="inspector-body">
        {error && <div className="notice error">{error}</div>}
        {tab === "parameters" ? (
          <fieldset className="readonly-fields" disabled={readOnly}>
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
                      <Select
                        aria-label={port}
                        value={
                          edge ? `${edge.source}:${edge.sourceHandle}` : ""
                        }
                        onChange={(e) => onInput(port, e.target.value)}
                      >
                        <option value="">{t("notConnected")}</option>
                        {graphNodes
                          .filter((n) => n.id !== node.id)
                          .flatMap((n) =>
                            outputPorts(n, definitionOf(n, snapshot)).map(
                              (p) => (
                                <option
                                  key={n.id + ":" + p}
                                  value={n.id + ":" + p}
                                >
                                  {n.label || n.id} · {p}
                                </option>
                              ),
                            ),
                          )}
                      </Select>
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
                worktree={snapshot.worktree.id}
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
                columns={inputColumns[parameter.type?.match(/\((\w+)\)/)?.[1]]}
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
          </fieldset>
        ) : tab === "sql" ? (
          <>
            <div className="segmented">
              <button
                className={sqlMode === "current" ? "active" : ""}
                aria-pressed={sqlMode === "current"}
                onClick={() => setSqlMode("current")}
              >
                {t("currentSql")}
              </button>
              <button
                className={sqlMode === "executed" ? "active" : ""}
                aria-pressed={sqlMode === "executed"}
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
            snapshot={snapshot}
            fullNode={fullNode}
            preview={preview}
            onSave={onSaveDocumentation}
          />
        )}
      </div>
    </aside>
  );
}
