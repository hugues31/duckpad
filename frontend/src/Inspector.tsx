import { BookOpen, Code2, Info, Settings2 } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";
import { Link as RouterLink } from "react-router";
import { retainedConflict, withQuery } from "./api";
import ConnectionOnboarding from "./ConnectionOnboarding";
import { containsPython, type NodeInterface } from "./graph";
import { nodeLabel, useT } from "./i18n";
import InputSelectors from "./InputSelectors";
import InspectorHeading from "./InspectorHeading";
import InspectorActions from "./InspectorActions";
import InspectorParameters from "./InspectorParameters";
import { sourcePreviewParams } from "./nodeParameters";
import { projectSettingsUrl } from "./navigation";
import type { NodeAction } from "./nodeActions";
import { nodeCode, nodeEntity, nodeSourcePath } from "./nodeCode";
import NodeDocumentation from "./NodeDocumentation";
import NodeInfo from "./NodeInfo";
import { numberBoundsError } from "./numberBounds";
import { baseType, typeArgument } from "./parameterType";
import { PartitionInspector } from "./PartitionControls";
import QueryBuilder from "./QueryBuilder";
import type { ResultsTab } from "./results";
import ResultSummary from "./ResultSummary";
import { useWorkspace } from "./shell";
import { isFileReader, isFolderReader } from "./SourceFileField";
import SourcePreview from "./SourcePreview";
import type {
  Documentation,
  FlowEdge,
  FlowNode,
  Json,
  ParsedTemplate,
  Snapshot,
  Statement,
  Statuses,
} from "./types";
import { useApiResource } from "./useApiResource";
import { useAutosavedDraft } from "./useAutosavedDraft";
import { useDatabaseObjects } from "./useDatabaseObjects";
import { useInputColumns } from "./useInputColumns";
import { useSaveShortcut } from "./useSaveShortcut";
import { StatementVariables } from "./VariableFields";
import { type Declaration } from "./variables";
import { useOptionalWorktree, usePartitionQuery } from "./worktree";

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
  actions,
  onRun,
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
  actions: NodeAction[];
  onRun: () => void;
  onHistory: () => void;
  /** Open the results panel on one of its tabs. */
  onResults: (tab: ResultsTab) => void;
  onClose: () => void;
}) {
  const t = useT();
  const workspace = useWorkspace();
  const panel = useRef<HTMLElement>(null);
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
    saveNow: persist,
    error: saveError,
    rejection,
  } = useAutosavedDraft(
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
    {
      readOnly,
    },
  );
  useSaveShortcut(() => {
    if (tab === "parameters" && !retainedConflict(rejection()))
      return persist();
  }, panel);
  const worktree = snapshot.worktree.id;
  const inputColumns = useInputColumns(
    snapshot,
    fullNode,
    environment,
    statuses,
  ).columns;
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
  // A resolved conflict discards the draft its error was about.
  const error =
    (dirty && saveError) ||
    compilation.error ||
    (signature.kind !== "component" && signature.definition?.error);
  const schemas = Object.fromEntries(
    Object.entries(inputColumns).map(([port, columns]) => [
      port,
      columns.map((column) => column.name),
    ]),
  );
  // A conflict retains this draft until it is resolved: blurring the field, for
  // instance to open that conflict, must not retain another one.
  const blur = () => {
    if (!retainedConflict(rejection())) void persist();
  };
  const { kind, parameters, inputs } = signature;
  // Only the root flow binds variables; component definitions stay portable.
  const bindable = !fullNode.includes("::");
  const setParameter = (name: string, value: Json | undefined) =>
    update((current) => {
      const params = { ...current.params };
      if (value === undefined) delete params[name];
      else params[name] = value;
      return { ...current, params };
    });
  const { valueOf, listedSchema, listedConnection, database, objectNames } =
    useDatabaseObjects(
      parameters,
      draft,
      connections,
      tab === "parameters",
      worktree,
      environment,
    );
  // Connection parameters naming where file and destination parameters live.
  const locations = new Set(
    parameters
      .filter((p) => ["file", "destination"].includes(baseType(p.type)))
      .map((p) => typeArgument(p.type)),
  );
  const nodeProblems = snapshot.diagnostics.filter(
    (item) => item.file === "flow.json" && item.node === node.id,
  );
  const sourceKind = node.preset || node.template || node.origin;
  const csvSource = sourceKind === "load_csv";
  const fileSource = isFileReader(sourceKind) && !valueOf("connection");
  const previewParams = sourcePreviewParams(draft, parameters, fileSource);
  // The preview edits CSV types once it reads the file; an expression or a bound variable keeps the field.
  const typesInPreview =
    csvSource &&
    fileSource &&
    (!!previewParams ||
      !(
        draft.params.file ?? parameters.find((p) => p.name === "file")?.default
      ));
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
    <aside className="inspector" ref={panel}>
      <InspectorHeading
        title={nodeLabel(node, signature, t)}
        node={node}
        kind={kind}
        snapshot={snapshot}
        onClose={onClose}
      />
      <InspectorActions
        actions={actions}
        starting={starting}
        runDisabled={readOnly || !!starting || !!statuses.active}
        onRun={onRun}
      />
      <ResultSummary
        bundle={snapshot.bundle}
        fullNode={fullNode}
        ports={signature.outputs}
        hasInputs={signature.inputs.length > 0}
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
        {node.muted && (
          <p className="notice">
            <strong>{t("mutedNode")}.</strong> {t("mutedNodeHint")}{" "}
            {!readOnly && (
              <button
                className="text-button"
                onClick={() =>
                  actions.find((item) => item.id === "mute")?.run()
                }
              >
                {t("unmuteNode")}
              </button>
            )}
          </p>
        )}
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
                onBlur={blur}
              />
            </label>
            {node.component && (
              <p className="muted small">{t("sharedTemplateHint")}</p>
            )}
            <InputSelectors
              inputs={inputs}
              graphEdges={graphEdges}
              node={node}
              graphNodes={graphNodes}
              snapshot={snapshot}
              local={local}
              onInput={onInput}
            />
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
                <ConnectionOnboarding
                  workspace={workspace}
                  snapshot={snapshot}
                  worktree={worktree}
                  fullNode={fullNode}
                />
              )}
            <InspectorParameters
              parameters={parameters}
              typesInPreview={typesInPreview}
              draft={draft}
              bindable={bindable}
              snapshot={snapshot}
              readOnly={readOnly}
              setParameter={setParameter}
              persist={persist}
              declared={declared}
              rejection={rejection}
              worktree={worktree}
              environment={environment}
              nodeProblems={nodeProblems}
              update={update}
              fileSource={fileSource}
              folderSource={isFolderReader(sourceKind)}
              listedConnection={listedConnection}
              listedSchema={listedSchema}
              listedTable={listedTable}
              blur={blur}
              connections={connections}
              locations={locations}
              valueOf={valueOf}
              csvSource={csvSource}
              objectNames={objectNames}
              inputColumns={inputColumns}
              schemas={schemas}
            />
            {!readOnly && (
              <SourcePreview
                worktree={worktree}
                params={previewParams}
                csv={csvSource}
                tableUrl={tablePreviewUrl}
                onTypes={(types) => setParameter("types", types)}
              />
            )}
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
