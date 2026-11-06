import { useWorkspace } from "./shell";
import SourcePreview from "./SourcePreview";
import { sourceFileName } from "./SourceFileField";
import { PartitionInspector } from "./PartitionControls";
import { useOptionalWorktree, usePartitionQuery } from "./worktree";
import Select from "./Select";
import {
  nodeCode,
  nodeEntity,
  nodeSourcePath,
  templateUsage,
} from "./nodeCode";
import { lazy, Suspense, useRef, useState } from "react";
import { Link as RouterLink } from "react-router";
import {
  ArrowRight,
  BookOpen,
  Boxes,
  Code2,
  Info,
  Link,
  Loader2,
  Play,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import { api, withQuery } from "./api";
import { containsPython, nodeInterface, type NodeInterface } from "./graph";
import { nodeLabel, templateLabel, useT } from "./i18n";
import { projectSettingsUrl } from "./navigation";
import NodeDocumentation from "./NodeDocumentation";
import NodeInfo from "./NodeInfo";
import { numberBoundsError } from "./numberBounds";
import ParameterField from "./ParameterField";
import QueryBuilder from "./QueryBuilder";
import type { ResultsTab } from "./ResultsPanel";
import ResultSummary from "./ResultSummary";
import { useIdleSave, useRevisionDraft } from "./useRevisionDraft";
import type {
  Column,
  DatabaseObjects,
  Documentation,
  FlowEdge,
  FlowNode,
  Json,
  PreviewPage,
  Snapshot,
  ParsedTemplate,
  Statement,
  Statuses,
} from "./types";
import { useApiResource, useResource } from "./useApiResource";
import { BoundVariable, VariablePicker } from "./VariableBinding";
import { StatementVariables } from "./VariableFields";
import {
  bindTo,
  variableReference,
  variableSummary,
  variableTypeFor,
  type Declaration,
} from "./variables";

const CodeEditor = lazy(() => import("./Editor"));

const TABS = [
  ["parameters", Settings2],
  ["sql", Code2],
  ["notes", BookOpen],
  ["info", Info],
] as const;

export default function Inspector({
  readOnly = false,
  node,
  parent,
  signature,
  snapshot,
  graphNodes,
  local,
  graphEdges,
  fullNode,
  environment,
  connections,
  statuses,
  onSave,
  onSaveDocumentation,
  onInput,
  onDelete,
  onRun,
  onOpen,
  onEditTemplate,
  onViewCode,
  onDetach,
  onConvert,
  onRelink,
  onDuplicate,
  onHistory,
  onResults,
  onClose,
}: {
  readOnly?: boolean;
  node: FlowNode;
  /** The component definition holding the node, if not the root flow. */
  parent?: string;
  signature: NodeInterface;
  snapshot: Snapshot;
  graphNodes: FlowNode[];
  local: Record<string, ParsedTemplate>;
  graphEdges: FlowEdge[];
  fullNode: string;
  environment: string;
  connections: Snapshot["connections"];
  statuses: Statuses;
  /** Save the node, with the variables it binds for the first time, in one change. */
  onSave: (
    node: FlowNode,
    base: Snapshot,
    variables: Record<string, Declaration>,
  ) => Promise<Snapshot>;
  onSaveDocumentation: (
    change: (documentation: Documentation) => void,
    base: Snapshot,
  ) => Promise<Snapshot>;
  onInput: (port: string, source: string) => void;
  onDelete: () => void;
  onRun: () => void;
  onOpen: () => void;
  onEditTemplate: () => void;
  onViewCode: () => void;
  onDetach: () => void;
  onConvert: () => void;
  onRelink: () => void;
  onDuplicate: () => void;
  onHistory: () => void;
  /** Open the results panel on one of its tabs. */
  onResults: (tab: ResultsTab) => void;
  onClose: () => void;
}) {
  const t = useT();
  const workspace = useWorkspace();
  const starting = useOptionalWorktree()?.starting;
  const partition = usePartitionQuery(fullNode);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("parameters");
  // Variables created from a parameter, declared by the save that binds it.
  const declared = useRef<Record<string, Declaration>>({});
  // Edits are saved after a pause, on blur, and when the panel closes.
  const {
    draft,
    dirty,
    update,
    persist: saveDraft,
    rejected,
  } = useRevisionDraft(
    node,
    snapshot,
    async (value: FlowNode, base: Snapshot) => {
      // Incomplete numeric text is a dirty draft, but navigation must not save it.
      if (
        signature.parameters.some((parameter) => {
          const current = value.params[parameter.name];
          return (
            parameter.type === "number" &&
            typeof current === "string" &&
            !Number.isFinite(Number(current))
          );
        })
      )
        throw new Error(t("invalidNumber"));
      for (const parameter of signature.parameters) {
        const current = value.params[parameter.name] ?? parameter.default;
        const invalid =
          typeof current === "number" &&
          numberBoundsError(current, parameter, t);
        if (invalid) throw new Error(invalid);
      }
      const variables = { ...declared.current };
      const saved = await onSave(value, base, variables);
      for (const name of Object.keys(variables)) delete declared.current[name];
      return saved;
    },
    { autosave: !readOnly },
  );
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
                    {
                      environment,
                      port: edge.sourceHandle,
                      limit: 1,
                      ...partition,
                    },
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
  // Python has no compiled SQL, so neither has a component containing it.
  const python =
    node.language === "python" ||
    (!!node.component &&
      containsPython(snapshot.bundle?.components || {}, node.component));
  const compilation = useApiResource<Statement[]>(
    tab === "sql" && !python
      ? withQuery(
          `/worktrees/${worktree}/compile/${encodeURIComponent(fullNode)}`,
          { environment, ...partition },
        )
      : null,
    { refresh: snapshot.revision },
  );
  const error =
    saveError ||
    compilation.error ||
    (signature.kind !== "component" && signature.definition?.error);
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
  useIdleSave(draft, dirty && !readOnly, () => {
    if (!rejected()) void persist();
  });
  const { kind, parameters, inputs } = signature;
  const linkedCount = node.template
    ? templateUsage(snapshot.bundle!, node.template)
    : 0;
  // Only the root flow binds variables; component definitions stay portable.
  const bindable = !fullNode.includes("::");
  const setParameter = (name: string, value: Json | undefined) =>
    update((current) => {
      const params = { ...current.params };
      if (value === undefined) delete params[name];
      else params[name] = value;
      return { ...current, params };
    });
  // Schema and table names are listed from the database connection of the first schema
  // parameter. Fields bound to another connection get no suggestions.
  const valueOf = (name?: string) => {
    const parameter = parameters.find((p) => p.name === name);
    const value = draft.params?.[name ?? ""] ?? parameter?.default;
    return typeof value === "string" ? value : "";
  };
  const argumentOf = (name?: string) =>
    parameters.find((p) => p.name === name)?.type.match(/\((\w+)\)/)?.[1];
  const listedSchema = parameters.find((p) =>
    p.type.startsWith("schema_name("),
  )?.name;
  const listedConnection = argumentOf(listedSchema);
  const database = valueOf(listedConnection);
  const objects = useApiResource<DatabaseObjects>(
    tab === "parameters" &&
      connections.some((c) => c.id === database && c.family === "database")
      ? withQuery(
          `/worktrees/${worktree}/connections/${encodeURIComponent(database)}/objects`,
          { environment },
        )
      : null,
  );
  const objectNames = (parameter: { name: string; type: string }) => {
    if (!listedConnection) return undefined;
    const base = parameter.type.split("(")[0];
    const argument = argumentOf(parameter.name);
    // The listing's progress and error show once, under the first schema field.
    const status =
      parameter.name === listedSchema
        ? { pending: objects.pending, error: objects.error }
        : { pending: false, error: "" };
    if (base === "schema_name" && argument === listedConnection)
      return { names: objects.data?.schemas ?? [], ...status };
    if (base === "table_name" && argumentOf(argument) === listedConnection)
      return {
        names: (objects.data?.tables ?? [])
          .filter((table) => table.schema === valueOf(argument))
          .map((table) => table.name),
        ...status,
      };
    return undefined;
  };
  // Connection parameters naming where file and destination parameters live.
  const locations = new Set(
    parameters
      .filter((p) => /^(file|destination)\(/.test(p.type))
      .map((p) => p.type.match(/\((\w+)\)/)?.[1]),
  );
  const nodeProblems = snapshot.diagnostics.filter(
    (item) => item.file === "flow.json" && item.node === node.id,
  );
  const sourceKind = node.preset || node.template || node.origin;
  const csvSource = sourceKind === "load_csv";
  const fileSource =
    !!sourceKind &&
    /^load_(csv|parquet|xlsx|json)$/.test(sourceKind) &&
    !valueOf("connection");
  const fileValue = valueOf("file");
  const previewParams: Record<string, Json> | null =
    fileSource && fileValue && !fileValue.includes("{{")
      ? { file: fileValue }
      : null;
  if (previewParams)
    for (const key of [
      "delimiter",
      "header",
      "types",
      "sheet",
      "all_varchar",
    ]) {
      const value =
        draft.params[key] ?? parameters.find((p) => p.name === key)?.default;
      if (value !== undefined && !variableReference(value)) {
        if (key === "types" && typeof value === "string") {
          try {
            previewParams[key] = JSON.parse(value);
          } catch {
            previewParams[key] = value;
          }
        } else previewParams[key] = value;
      }
    }
  const listedTable = parameters.find((p) =>
    p.type.startsWith("table_name("),
  )?.name;
  const tablePreviewUrl =
    sourceKind === "load_table" &&
    database &&
    valueOf(listedSchema) &&
    valueOf(listedTable)
      ? withQuery(
          `/worktrees/${worktree}/connections/${encodeURIComponent(database)}/preview`,
          {
            environment,
            schema: valueOf(listedSchema),
            table: valueOf(listedTable),
          },
        )
      : null;
  const statements: Statement[] = compilation.data || [];
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
          <small>
            {node.template ? (
              <>
                <Link size={12} /> {t("linkedNode")} ·{" "}
                {templateLabel(
                  node.template,
                  snapshot.parsed_templates[node.template]?.label,
                  t,
                )}
              </>
            ) : (
              node.component || t("normalNode")
            )}
          </small>
        </div>
        <button
          className="icon run-node"
          title={t("runNode")}
          disabled={readOnly || starting || !!statuses.active}
          aria-busy={starting}
          onClick={onRun}
        >
          {starting ? (
            <Loader2 size={16} className="spin" />
          ) : (
            <Play size={16} />
          )}
        </button>
      </div>
      <ResultSummary
        bundle={snapshot.bundle}
        fullNode={fullNode}
        ports={signature.outputs}
        statuses={statuses}
        onOpen={onResults}
      />
      <div className="tabs inspector-tabs">
        {TABS.map(([key, Icon]) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            aria-pressed={tab === key}
            title={t(
              key === "sql" && node.language === "python" ? "code" : key,
            )}
            onClick={() => setTab(key)}
          >
            <Icon size={14} />
            <span>
              {t(key === "sql" && node.language === "python" ? "code" : key)}
            </span>
          </button>
        ))}
      </div>
      <div className="inspector-body">
        {node.language === "python" && !snapshot.python_enabled && (
          <p className="notice">
            {t("pythonDisabledHint")}{" "}
            <RouterLink
              to={projectSettingsUrl(snapshot.worktree.project, "python")}
            >
              {t("pythonOpenSettings")}
            </RouterLink>
          </p>
        )}
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
                          .flatMap((n) => {
                            const source = nodeInterface(
                              n,
                              snapshot.parsed_templates,
                              snapshot.bundle?.components,
                              local,
                            );
                            return source.outputs.map((p) => (
                              <option
                                key={n.id + ":" + p}
                                value={n.id + ":" + p}
                              >
                                {nodeLabel(n, source, t)} · {p}
                              </option>
                            ));
                          })}
                      </Select>
                    </label>
                  );
                })}
              </>
            )}
            <PartitionInspector
              node={draft}
              fullNode={fullNode}
              ports={signature.outputs}
              onChange={(next) => update(() => next)}
            />
            {!!parameters.length && <h4>{t("parameters")}</h4>}
            <QueryBuilder
              kind={node.preset || node.template || node.origin || ""}
              parameters={parameters.map((p) => p.name)}
              schemas={inputColumns}
              variables={bindable ? snapshot.variables : null}
              environment={environment}
              onChange={(values) =>
                update((current) => ({
                  ...current,
                  params: { ...current.params, ...values },
                }))
              }
            />
            {sourceKind === "load_table" &&
              !connections.some((c) => c.family === "database") && (
                <div className="source-empty notice">
                  <p>{t("noProjectConnections")}</p>
                  {workspace.user.role === "admin" ? (
                    <>
                      <RouterLink
                        className="button secondary"
                        to={`/instance-settings/connections?project=${snapshot.worktree.project}&worktree=${worktree}&node=${encodeURIComponent(fullNode)}`}
                      >
                        {t("createSourceConnection")}
                      </RouterLink>
                      <RouterLink
                        to={`/projects/${snapshot.worktree.project}/settings/connections?worktree=${worktree}`}
                      >
                        {t("authorizeSourceConnection")}
                      </RouterLink>
                    </>
                  ) : (
                    <>
                      <p>{t("askAdministratorHint")}</p>
                      <RouterLink
                        className="button secondary"
                        to={`/projects/${snapshot.worktree.project}/settings/participants?worktree=${worktree}`}
                      >
                        {t("askAdministrator")}
                      </RouterLink>
                    </>
                  )}
                </div>
              )}
            {parameters
              .filter((p) => !(fileSource && csvSource && p.name === "types"))
              .map((parameter) => {
                const value =
                  draft.params?.[parameter.name] ?? parameter.default;
                const type = parameter.type || "text";
                const reference = variableReference(value);
                const variableType = bindable ? variableTypeFor(type) : null;
                // Column parameters name the input port they choose from.
                const port = parameter.type.match(/\((\w+)\)/)?.[1];
                return (
                  <ParameterField
                    key={parameter.name}
                    worktree={snapshot.worktree.id}
                    parameter={parameter}
                    value={value}
                    variable={
                      variableType || reference
                        ? {
                            control: variableType && (
                              <VariablePicker
                                snapshot={snapshot}
                                parameter={parameter.name}
                                parameterType={type}
                                variableType={variableType}
                                value={reference ? undefined : value}
                                disabled={readOnly}
                                onBind={(name) => {
                                  setParameter(parameter.name, bindTo(name));
                                  void persist();
                                }}
                                onCreate={async (name, declaration) => {
                                  declared.current[name] = declaration;
                                  setParameter(parameter.name, bindTo(name));
                                  await saveDraft();
                                }}
                              />
                            ),
                            bound: reference && (
                              <BoundVariable
                                snapshot={snapshot}
                                worktree={worktree}
                                environment={environment}
                                parameter={parameter.name}
                                parameterType={type}
                                name={reference}
                                problem={
                                  nodeProblems.find((item) =>
                                    String(item.message).includes(
                                      `parameter ${parameter.name}`,
                                    ),
                                  )?.message
                                }
                                disabled={readOnly}
                                onUnbind={() => {
                                  // Keep computing the same value, now written in the node.
                                  const current = variableSummary(
                                    snapshot,
                                    reference,
                                  )?.values[environment];
                                  setParameter(parameter.name, current?.value);
                                  void persist();
                                }}
                              />
                            ),
                          }
                        : undefined
                    }
                    onChange={(value, settings) => {
                      if (parameter.name === "file" && fileSource) {
                        update((current) => ({
                          ...current,
                          label:
                            !current.label ||
                            current.label ===
                              sourceFileName(String(current.params.file || ""))
                              ? sourceFileName(String(value || "")) || undefined
                              : current.label,
                          params: {
                            ...current.params,
                            file: value ?? "",
                            ...settings,
                          },
                        }));
                      } else {
                        setParameter(parameter.name, value);
                        if (parameter.name === listedConnection) {
                          if (listedSchema) setParameter(listedSchema, "");
                          if (listedTable) setParameter(listedTable, "");
                        } else if (
                          parameter.name === listedSchema &&
                          listedTable
                        )
                          setParameter(listedTable, "");
                      }
                    }}
                    onBlur={persist}
                    expressionVariables={
                      bindable
                        ? { summary: snapshot.variables, environment }
                        : undefined
                    }
                    connections={connections}
                    location={
                      type === "connection" && locations.has(parameter.name)
                    }
                    projectFile={type.startsWith("file") && !valueOf(port)}
                    csv={csvSource}
                    objects={objectNames(parameter)}
                    columns={port ? inputColumns[port] : undefined}
                    schemas={
                      (port && schemas[port]) || Object.values(schemas).flat()
                    }
                  />
                );
              })}
            <SourcePreview
              worktree={worktree}
              params={previewParams}
              csv={csvSource}
              tableUrl={tablePreviewUrl}
              onTypes={(types) => setParameter("types", types)}
            />
            {!node.component && (
              <button
                className="button secondary full"
                onClick={onEditTemplate}
              >
                <Code2 size={15} />
                {node.template
                  ? t(
                      linkedCount === 1
                        ? "editTemplateOne"
                        : "editTemplateCount",
                    ).replace("{count}", String(linkedCount))
                  : t("editNodeCode")}
              </button>
            )}
            {!node.component &&
              (node.template ? (
                <>
                  <button
                    className="button secondary full"
                    onClick={onViewCode}
                  >
                    {t("viewNodeCode")}
                  </button>
                  <button className="button secondary full" onClick={onDetach}>
                    {t("detachTemplate")}
                  </button>
                </>
              ) : (
                <>
                  <button className="button secondary full" onClick={onConvert}>
                    {t("convertTemplate")}
                  </button>
                  {node.origin &&
                    snapshot.bundle?.templates[node.origin] !== undefined && (
                      <button
                        className="button secondary full"
                        onClick={onRelink}
                      >
                        {t("relinkTemplate")}
                      </button>
                    )}
                </>
              ))}
            <button className="button secondary full" onClick={onDuplicate}>
              {t("duplicateNode")}
            </button>
            <div className="inspector-danger">
              <button className="text-button danger" onClick={onDelete}>
                <Trash2 size={14} />
                {t("deleteNode")}
              </button>
            </div>
          </fieldset>
        ) : tab === "sql" && node.language === "python" ? (
          <Suspense fallback={<p>{t("loading")}</p>}>
            <CodeEditor
              value={
                snapshot.bundle ? nodeCode(snapshot.bundle, node, parent) : ""
              }
              language="python"
              readOnly
              height="330px"
            />
          </Suspense>
        ) : tab === "sql" && python ? (
          <p className="notice">{t("pythonComponentNoSql")}</p>
        ) : tab === "sql" ? (
          <>
            <p className="muted small">{t("compileHint")}</p>
            <Suspense fallback={<p>{t("loading")}</p>}>
              <CodeEditor
                value={statements.map((s) => s.sql + ";").join("\n\n")}
                readOnly
                height="330px"
              />
            </Suspense>
            <StatementVariables
              statements={statements}
              environment={environment}
            />
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
        ) : tab === "info" ? (
          <NodeInfo
            worktree={worktree}
            entity={nodeEntity(node.id, parent)}
            template={node.template}
            revision={snapshot.revision}
            node={node.id}
            definitionFile={
              node.component
                ? `components/${node.component}.json`
                : nodeSourcePath(node, parent)
            }
            onHistory={onHistory}
          />
        ) : (
          <NodeDocumentation
            snapshot={snapshot}
            fullNode={fullNode}
            onSave={onSaveDocumentation}
          />
        )}
      </div>
    </aside>
  );
}
