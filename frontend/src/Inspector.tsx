import Select from "./Select";
import { lazy, Suspense, useState } from "react";
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
import { nodeInterface, type NodeInterface } from "./graph";
import { useT } from "./i18n";
import NodeDocumentation from "./NodeDocumentation";
import ExportDownload from "./ExportDownload";
import ParameterField from "./ParameterField";
import QueryBuilder from "./QueryBuilder";
import { useRevisionDraft } from "./useRevisionDraft";
import type {
  Column,
  Documentation,
  FlowEdge,
  FlowNode,
  PreviewPage,
  Snapshot,
  Statement,
  Statuses,
} from "./types";
import { useApiResource, useResource } from "./useApiResource";

const CodeEditor = lazy(() => import("./Editor"));

const TABS = [
  ["parameters", Settings2],
  ["sql", Code2],
  ["notes", BookOpen],
] as const;

export default function Inspector({
  readOnly = false,
  node,
  signature,
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
  signature: NodeInterface;
  snapshot: Snapshot;
  graphNodes: FlowNode[];
  graphEdges: FlowEdge[];
  fullNode: string;
  environment: string;
  connections: Snapshot["connections"];
  statuses: Statuses;
  preview: PreviewPage | null;
  onSave: (node: FlowNode, base: Snapshot) => Promise<Snapshot>;
  onSaveDocumentation: (
    change: (documentation: Documentation) => void,
    base: Snapshot,
  ) => Promise<Snapshot>;
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
  // Pending edits are saved when another node is selected or the panel closes.
  const {
    draft,
    update,
    persist: saveDraft,
  } = useRevisionDraft(node, snapshot, onSave, { autosave: !readOnly });
  const [sqlMode, setSqlMode] = useState<"current" | "executed">("current");
  const [saveError, setError] = useState("");
  const worktree = snapshot.worktree.id;
  const prefix = fullNode.includes("::")
    ? fullNode.slice(0, fullNode.lastIndexOf("::") + 2)
    : "";
  const inputEdges = graphEdges.filter((e) => e.target === node.id);
  // Column suggestions come from the materialized inputs; refresh them when results change.
  const inputColumns =
    useResource(
      `${worktree}:${fullNode}`,
      async (signal) =>
        Object.fromEntries(
          await Promise.all(
            inputEdges.map(async (edge) => {
              try {
                const result = await api<PreviewPage>(
                  withQuery(
                    `/worktrees/${worktree}/preview/${encodeURIComponent(prefix + edge.source)}`,
                    { environment, port: edge.sourceHandle, limit: 1 },
                  ),
                  { signal },
                );
                return [edge.targetHandle, result.columns] as const;
              } catch {
                return [edge.targetHandle, [] as Column[]] as const;
              }
            }),
          ),
        ),
      {
        refresh: JSON.stringify([
          environment,
          inputEdges.map((e) => [e.source, e.sourceHandle, e.targetHandle]),
          statuses.nodes,
        ]),
      },
    ).data || {};
  const compilation = useApiResource<Statement[]>(
    tab === "sql" && sqlMode === "current"
      ? withQuery(
          `/worktrees/${worktree}/compile/${encodeURIComponent(fullNode)}`,
          { environment },
        )
      : null,
    { refresh: snapshot.revision },
  );
  const error = saveError || compilation.error;
  const schemas = Object.fromEntries(
    Object.entries(inputColumns).map(([port, columns]) => [
      port,
      columns.map((column) => column.name),
    ]),
  );
  const persist = async () => {
    if (readOnly) return;
    setError("");
    try {
      await saveDraft();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const { kind, parameters, inputs } = signature;
  const statements: Statement[] =
    sqlMode === "executed"
      ? preview?.executed_sql || []
      : compilation.data || [];
  return (
    <aside className="inspector">
      <div className="inspector-title">
        <span>
          {node.label ||
            (signature.kind === "component"
              ? signature.definition?.name
              : signature.definition?.label)}
        </span>
        <button className="icon" onClick={onClose} title={t("close")}>
          <X size={18} />
        </button>
      </div>
      <div className="inspector-kind">
        <span className={`kind-icon ${node.component ? "component" : ""}`}>
          {node.component ? <Boxes size={18} /> : <Settings2 size={18} />}
        </span>
        <div>
          <strong>{t(kind)}</strong>
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
      {signature.kind !== "component" && signature.definition?.download && (
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
                onChange={(e) =>
                  update((current) => ({ ...current, label: e.target.value }))
                }
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
                            nodeInterface(
                              n,
                              snapshot.parsed_templates,
                              snapshot.bundle?.components,
                            ).outputs.map((p) => (
                              <option
                                key={n.id + ":" + p}
                                value={n.id + ":" + p}
                              >
                                {n.label || n.id} · {p}
                              </option>
                            )),
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
              onApply={(values) => {
                update((current) => ({
                  ...current,
                  params: { ...current.params, ...values },
                }));
                void persist();
              }}
            />
            {parameters.map((parameter) => {
              // Column parameters name the input port they choose from.
              const port = parameter.type.match(/\((\w+)\)/)?.[1];
              return (
                <ParameterField
                  key={parameter.name}
                  worktree={snapshot.worktree.id}
                  parameter={parameter}
                  value={draft.params?.[parameter.name] ?? parameter.default}
                  onChange={(value) =>
                    update((current) => {
                      const params = { ...current.params };
                      if (value === undefined) delete params[parameter.name];
                      else params[parameter.name] = value;
                      return { ...current, params };
                    })
                  }
                  onBlur={persist}
                  connections={connections}
                  columns={port ? inputColumns[port] : undefined}
                  schemas={
                    (port && schemas[port]) || Object.values(schemas).flat()
                  }
                />
              );
            })}
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
