import {
  AlertTriangle,
  ArrowUpRight,
  ChartColumn,
  CircleCheck,
  CircleDashed,
  CircleX,
  Eye,
  Variable,
} from "lucide-react";
import { Fragment, memo, type ReactNode } from "react";
import { Link } from "react-router";
import { NodeIcon } from "./CanvasNode";
import { FAMILIES } from "./connectionFamilies";
import { formatValue } from "./graph";
import {
  countLabel,
  useLanguage,
  useT,
  type Translate,
  type TranslationKey,
} from "./i18n";
import MarkdownText from "./MarkdownText";
import { worktreeUrl } from "./navigation";
import { colorClass } from "./nodeAppearance";
import PipelineDiagram from "./PipelineDiagram";
import {
  nodeAnchor,
  type DocumentedLink,
  type DocumentedNode,
  type DocumentedOutput,
  type DocumentedTest,
  type ProjectDocumentation,
} from "./projectDocumentation";
import type { Environment } from "./types";
import { formatVariableValue } from "./variables";

const KIND_LABELS = {
  source: "source",
  transform: "transform",
  export: "export",
  component: "component",
} as const satisfies Record<DocumentedNode["kind"], TranslationKey>;

const TEST_STATUS = {
  ok: { label: "testOK", Icon: CircleCheck },
  warning: { label: "messageWarning", Icon: AlertTriangle },
  error: { label: "messageError", Icon: CircleX },
} as const;

/** Where the page is shown, for links that leave the documentation. */
interface Context {
  worktree: string;
  environment: string;
  /** Everything is unfolded while the page prints. */
  printing: boolean;
}

/** The sections of the generated reference, in page order, with their sizes. */
export function documentationSections(documentation: ProjectDocumentation) {
  return (
    [
      ["doc-sources", "sources", documentation.sources],
      ["doc-transformations", "transforms", documentation.transformations],
      ["doc-exports", "exports", documentation.exports],
    ] as const
  ).filter(([, , nodes]) => nodes.length);
}

function Links({ links }: { links: DocumentedLink[] }) {
  return (
    <span className="doc-links">
      {links.map((link) => (
        <a key={link.id + (link.port || "")} href={"#" + nodeAnchor(link.id)}>
          {link.label}
          {link.port && <small>{link.port}</small>}
        </a>
      ))}
    </span>
  );
}

function TestStatus({ test }: { test: DocumentedTest }) {
  const t = useT();
  const status = test.status && TEST_STATUS[test.status];
  const Icon = status?.Icon || CircleDashed;
  return (
    <span className={`doc-test-status ${test.status || "pending"}`}>
      <Icon size={14} aria-hidden="true" />
      {t(status?.label || "notRun")}
      {!!test.observed && (
        <small>
          {t("testFailingRows").replace(
            "{count}",
            test.observed.toLocaleString(),
          )}
        </small>
      )}
    </span>
  );
}

function Output({
  output,
  single,
  open,
  language,
  t,
}: {
  output: DocumentedOutput;
  /** The node has only this output: its name adds nothing to the node's. */
  single: boolean;
  open: boolean;
  language: string;
  t: Translate;
}) {
  const { dataset } = output;
  return (
    <details className="doc-output" open={open}>
      <summary>
        <span className="eyebrow">{t("output")}</span>
        {!(single && output.port === "result") && <code>{output.port}</code>}
        <span className="doc-output-facts">
          {dataset ? (
            <>
              <span>
                {countLabel(t, dataset.count, "docRowsOne", "docRows")}
              </span>
              <span>
                {countLabel(
                  t,
                  dataset.columns.length,
                  "logColumnsOne",
                  "logColumns",
                )}
              </span>
              <time dateTime={dataset.created}>
                {t("docUpdated").replace(
                  "{date}",
                  new Date(dataset.created).toLocaleString(language, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
                )}
              </time>
              {dataset.status === "stale" && (
                <span className="badge stale">{t("stale")}</span>
              )}
            </>
          ) : (
            <span>{t("notRun")}</span>
          )}
        </span>
      </summary>
      <MarkdownText headingOffset={5}>{output.description}</MarkdownText>
      {(!!output.charts.length || !!output.views.length) && (
        <p className="doc-saved">
          {output.charts.map((name) => (
            <span key={"chart" + name} title={t("results_chart")}>
              <ChartColumn size={13} aria-hidden="true" />
              {name}
            </span>
          ))}
          {output.views.map((name) => (
            <span key={"view" + name} title={t("docView")}>
              <Eye size={13} aria-hidden="true" />
              {name}
            </span>
          ))}
        </p>
      )}
      {output.columns.length ? (
        <table className="doc-table doc-columns">
          <thead>
            <tr>
              <th>{t("column")}</th>
              <th>{t("columnType")}</th>
              <th>{t("description")}</th>
            </tr>
          </thead>
          <tbody>
            {output.columns.map((column) => (
              <tr key={column.name}>
                <td>
                  <code>{column.name}</code>
                </td>
                <td>{column.type ? <code>{column.type}</code> : "—"}</td>
                <td>
                  <MarkdownText headingOffset={5}>
                    {column.description}
                  </MarkdownText>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        !dataset && (
          <p className="muted small">{t("documentationSchemaHint")}</p>
        )
      )}
    </details>
  );
}

function NodeSection({
  node,
  depth,
  context,
}: {
  node: DocumentedNode;
  /** 0 for a node of the flow, then one more per enclosing component. */
  depth: number;
  context: Context;
}) {
  const t = useT();
  const language = useLanguage();
  const Heading = `h${Math.min(3 + depth, 6)}` as "h3";
  const facts: [string, ReactNode][] = [
    ...(node.reads.length
      ? [
          [t("docReadsFrom"), <Links links={node.reads} />] as [
            string,
            ReactNode,
          ],
        ]
      : []),
    ...(node.feeds.length
      ? [[t("docFeeds"), <Links links={node.feeds} />] as [string, ReactNode]]
      : []),
    ...node.parameters.map(
      (parameter) =>
        [
          parameter.label,
          parameter.variable ? (
            <span className="doc-variable">
              <Variable size={13} aria-hidden="true" />
              {parameter.variable}
            </span>
          ) : parameter.connection ? (
            parameter.connection
          ) : (
            <code>{formatValue(parameter.value)}</code>
          ),
        ] as [string, ReactNode],
    ),
  ];
  return (
    <section
      id={nodeAnchor(node.id)}
      className={`doc-node ${node.kind} ${depth ? "doc-step" : ""}`}
      aria-labelledby={nodeAnchor(node.id) + "-title"}
      tabIndex={-1}
    >
      <header>
        <span
          className={`doc-node-icon ${colorClass(node.color)}`}
          aria-hidden="true"
        >
          <NodeIcon
            kind={node.icon}
            icon={node.declaredIcon}
            size={depth ? 15 : 18}
          />
        </span>
        <div>
          <Heading id={nodeAnchor(node.id) + "-title"}>{node.label}</Heading>
          <p className="doc-node-kind">
            {[
              t(KIND_LABELS[node.kind]),
              node.definition,
              node.language === "python" ? t("python") : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
            {node.muted && (
              <span className="badge neutral">{t("mutedNode")}</span>
            )}
          </p>
        </div>
        {!depth && (
          <Link
            className="doc-node-open"
            to={worktreeUrl(context.worktree, "flow", context.environment, {
              node: node.id,
            })}
            data-tooltip={t("docOpenInFlow")}
            aria-label={`${t("docOpenInFlow")}: ${node.label}`}
          >
            <ArrowUpRight size={15} aria-hidden="true" />
          </Link>
        )}
      </header>
      {node.description && (
        <div className="doc-prose">
          <MarkdownText headingOffset={5}>{node.description}</MarkdownText>
        </div>
      )}
      {!!facts.length && (
        <dl className="doc-facts">
          {facts.map(([label, value], index) => (
            <Fragment key={index}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
      {!!node.tests.length && (
        <ul className="doc-tests" aria-label={t("docTests")}>
          {node.tests.map((test) => (
            <li key={test.name}>
              <code>{test.name}</code>
              <TestStatus test={test} />
            </li>
          ))}
        </ul>
      )}
      {node.outputs.map((output) => (
        <Output
          // Remounted for printing: a section the reader folded prints open.
          key={output.port + (context.printing ? "\0print" : "")}
          output={output}
          single={node.outputs.length === 1}
          open={!depth || context.printing}
          language={language}
          t={t}
        />
      ))}
      {!!node.steps.length && (
        <div className="doc-steps">
          <p className="eyebrow">{t("docSteps")}</p>
          {node.steps.map((step) => (
            <NodeSection
              key={step.id}
              node={step}
              depth={depth + 1}
              context={context}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Variables({
  documentation,
  environments,
}: {
  documentation: ProjectDocumentation;
  environments: Environment[];
}) {
  const t = useT();
  const labels = new Map(
    [
      ...documentation.sources,
      ...documentation.transformations,
      ...documentation.exports,
    ].map((node) => [node.id, node.label]),
  );
  return (
    <section id="doc-variables" tabIndex={-1} aria-labelledby="doc-variables-h">
      <h2 id="doc-variables-h">{t("variables")}</h2>
      <div className="doc-table-frame">
        <table className="doc-table">
          <thead>
            <tr>
              <th>{t("name")}</th>
              <th>{t("columnType")}</th>
              <th>{t("defaultValue")}</th>
              {environments.map((environment) => (
                <th key={environment.id}>{environment.label}</th>
              ))}
              <th>{t("usedBy")}</th>
            </tr>
          </thead>
          <tbody>
            {documentation.variables.map((variable) => (
              <tr key={variable.name}>
                <td>
                  <code className="doc-strong">{variable.name}</code>
                  {variable.description && (
                    <p className="doc-cell-note">{variable.description}</p>
                  )}
                </td>
                <td>
                  <span className="badge neutral">{variable.type}</span>
                </td>
                <td>
                  {variable.from ? (
                    <>
                      {t("computedFromNode")}{" "}
                      <a href={"#" + nodeAnchor(variable.from.node)}>
                        {labels.get(variable.from.node) || variable.from.node}
                      </a>
                      <code>{variable.from.column}</code>
                    </>
                  ) : (
                    <code>{formatVariableValue(variable.default)}</code>
                  )}
                </td>
                {environments.map((environment) => {
                  const value = variable.values[environment.id];
                  return (
                    <td key={environment.id}>
                      {value && "value" in value ? (
                        <code>{formatVariableValue(value.value)}</code>
                      ) : (
                        "—"
                      )}
                    </td>
                  );
                })}
                <td>
                  {variable.usages.length ? (
                    <Links
                      links={variable.usages
                        .map((usage) => ({
                          id: usage.node,
                          label: usage.label,
                        }))
                        .filter(
                          (link, index, all) =>
                            all.findIndex((other) => other.id === link.id) ===
                            index,
                        )}
                    />
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Tests({ documentation }: { documentation: ProjectDocumentation }) {
  const t = useT();
  return (
    <section id="doc-tests" tabIndex={-1} aria-labelledby="doc-tests-h">
      <h2 id="doc-tests-h">{t("docTests")}</h2>
      <div className="doc-table-frame">
        <table className="doc-table">
          <thead>
            <tr>
              <th>{t("test")}</th>
              <th>{t("node")}</th>
              <th>{t("testSeverity")}</th>
              <th>{t("status")}</th>
            </tr>
          </thead>
          <tbody>
            {documentation.tests.map(({ node, test }) => (
              <tr key={node.id + "\0" + test.name}>
                <td>
                  <code className="doc-strong">{test.name}</code>
                </td>
                <td>
                  <a href={"#" + nodeAnchor(node.id)}>{node.label}</a>
                </td>
                <td>
                  {test.severity
                    ? t(
                        test.severity === "warning"
                          ? "messageWarning"
                          : "messageError",
                      )
                    : "—"}
                </td>
                <td>
                  <TestStatus test={test} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Connections({
  documentation,
}: {
  documentation: ProjectDocumentation;
}) {
  const t = useT();
  return (
    <section
      id="doc-connections"
      tabIndex={-1}
      aria-labelledby="doc-connections-h"
    >
      <h2 id="doc-connections-h">{t("connections")}</h2>
      <div className="doc-table-frame">
        <table className="doc-table">
          <thead>
            <tr>
              <th>{t("name")}</th>
              <th>{t("columnType")}</th>
              <th>{t("docAccess")}</th>
              <th>{t("usedBy")}</th>
            </tr>
          </thead>
          <tbody>
            {documentation.connections.map((connection) => {
              const family = FAMILIES.find(
                (item) => item.family === connection.family,
              );
              return (
                <tr key={connection.id}>
                  <td>
                    <span className="doc-strong">{connection.name}</span>
                  </td>
                  <td>{family ? t(family.label) : "—"}</td>
                  <td>
                    {connection.capabilities
                      .map((capability) => t(capability))
                      .join(", ") || "—"}
                  </td>
                  <td>
                    {connection.usedBy.length ? (
                      <Links links={connection.usedBy} />
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * The read-only reference generated from the project. Memoized: the overview
 * editor above re-renders on every keystroke.
 */
export default memo(function GeneratedDocumentation({
  documentation,
  environments,
  ...context
}: Context & {
  documentation: ProjectDocumentation;
  environments: Environment[];
}) {
  const t = useT();
  return (
    <>
      {!!documentation.diagram.nodes.length && (
        <section
          id="doc-pipeline"
          tabIndex={-1}
          aria-labelledby="doc-pipeline-h"
        >
          <h2 id="doc-pipeline-h">{t("docPipeline")}</h2>
          <PipelineDiagram diagram={documentation.diagram} />
        </section>
      )}
      {documentationSections(documentation).map(([id, label, nodes]) => (
        <section key={id} id={id} tabIndex={-1} aria-labelledby={id + "-h"}>
          <h2 id={id + "-h"}>
            {t(label)}
            <span className="doc-count">{nodes.length}</span>
          </h2>
          {nodes.map((node) => (
            <NodeSection
              key={node.id}
              node={node}
              depth={0}
              context={context}
            />
          ))}
        </section>
      ))}
      {!!documentation.variables.length && (
        <Variables documentation={documentation} environments={environments} />
      )}
      {!!documentation.tests.length && <Tests documentation={documentation} />}
      {!!documentation.connections.length && (
        <Connections documentation={documentation} />
      )}
    </>
  );
});
