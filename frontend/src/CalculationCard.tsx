import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  AlertTriangle,
  ArrowRight,
  ChevronLeft,
  Database,
  GitBranch,
  Layers,
} from "lucide-react";
import { PythonIcon } from "./AddIcon";
import { formatValue } from "./graph";
import { useT, useTranslateValue } from "./i18n";
import {
  type Cell,
  type Entry,
  type Explanation,
  type Query,
} from "./lineageGraph";
import { displayNodeName } from "./nodeNames";
import Pager from "./Pager";
import { useOptionalWorktree } from "./worktree";

type CardData = {
  entry: Entry;
  root: boolean;
  disabled: boolean;
  select: (id: string) => void;
  page: (id: string, values: Partial<Query>) => void;
  expand: () => void;
  parent: (cell: Cell) => void;
  /** Whether this card lists the captured parents of its Python result. */
  parents: boolean;
  replay?: (value: NonNullable<Explanation["replay"]>) => void;
};

export type CardNode = Node<CardData, "lineage">;

export const operationKeys = {
  sum: "lineageSum",
  avg: "lineageAverage",
  min: "lineageMinimum",
  max: "lineageMaximum",
  count: "lineageCount",
  count_distinct: "lineageDistinctCount",
} as const;

const isExplained = (
  operation: string,
): operation is keyof typeof operationKeys =>
  Object.hasOwn(operationKeys, operation);

export function CalculationCard({ data }: NodeProps<CardNode>) {
  const t = useT();
  const translate = useTranslateValue();
  const names = useOptionalWorktree()?.snapshot?.node_names;
  const { entry, disabled } = data;
  const { result, query, group } = entry;
  const source = result.kind === "source" && !entry.deferred;
  const operation = result.calculation?.operation || "expression";
  let formula =
    result.calculation?.evaluated ||
    result.calculation?.formula ||
    result.expression;
  if (
    (operation === "sum" || operation === "avg") &&
    result.total > 0 &&
    result.total === result.contributions.length &&
    result.contributions.every(
      (input) =>
        typeof input.value === "number" && Number.isFinite(input.value),
    ) &&
    !query.offset &&
    query.group === undefined
  ) {
    const values = result.contributions
      .map((input) => formatValue(input.value))
      .join(" + ");
    formula = operation === "sum" ? values : `(${values}) / ${result.total}`;
  }
  // The card header names the opaque Python operation; it has no formula.
  const python = result.kind === "python";
  if (python) formula = undefined;
  const offset = query.offset || 0;
  // Parent results page together; the longest one sets the page count.
  const parentRows = Math.max(
    0,
    ...(result.parents || []).map((parent) => parent.count),
  );
  return (
    <article
      className={`lineage-card ${source ? "is-source" : "calculation"} ${python ? "python" : ""} ${data.root ? "root" : ""}`}
      aria-label={`${result.column}: ${formatValue(result.value)}`}
    >
      {!source && !group && (
        <Handle type="target" position={Position.Left} isConnectable={false} />
      )}
      {!data.root && (
        <Handle type="source" position={Position.Right} isConnectable={false} />
      )}
      <div className="lineage-card-kind">
        {source ? (
          <Database size={14} />
        ) : group ? (
          <Layers size={14} />
        ) : python ? (
          <PythonIcon size={14} />
        ) : (
          <GitBranch size={14} />
        )}
        {t(
          entry.deferred
            ? "lineageEarlierValue"
            : source
              ? "lineageSource"
              : group
                ? "lineageValueGroup"
                : python
                  ? "pythonOpaque"
                  : !result.complete
                    ? "partial"
                    : isExplained(operation)
                      ? operationKeys[operation]
                      : "lineageCalculation",
        )}
        {data.root && <span>{t("lineageSelectedValue")}</span>}
      </div>
      <div className="lineage-card-value">
        <strong>{result.column}</strong>
        <span>=</span>
        <b title={formatValue(result.value)}>{formatValue(result.value)}</b>
      </div>
      {result.origin && (
        <p className="lineage-source-location">
          {t("partitionOrigin")}: {String(result.origin.partition.key.value)} ·{" "}
          {translate(result.origin.partition.key.type)}
          <br />
          {t("partitionProducingRun")}: <code>{result.origin.run}</code>
        </p>
      )}
      {!!result.partition_groups?.length && (
        <p className="lineage-source-location">
          {t("partitionContributors")}:{" "}
          {result.partition_groups
            .map(
              (group) => `${String(group.partition.key.value)} (${group.rows})`,
            )
            .join(", ")}
        </p>
      )}
      {result.replay && (
        <div className="partition-lineage-replay">
          <p>
            {t("partitionOriginUnavailable").replace(
              "{key}",
              String(result.origin?.partition.key.value),
            )}
          </p>
          {data.replay && (
            <button
              className="button secondary small nodrag"
              disabled={disabled}
              onClick={() => data.replay!(result.replay!)}
            >
              {t("partitionRunToExplain")}
            </button>
          )}
          <p>{t("partitionReplayHint")}</p>
        </div>
      )}
      {python && (
        <p className="lineage-source-location">
          {displayNodeName(names?.[result.node || ""], result.node || "", t)} ·{" "}
          {t("lineageRow")} {result.row + 1}
        </p>
      )}
      {python && data.parents && !!result.parents?.length && (
        <>
          <p className="lineage-card-reason">{t("pythonParentHint")}</p>
          <div className="lineage-parents nodrag nowheel">
            <p className="muted small">{t("pythonCapturedParents")}</p>
            {result.parents?.map((parent) => (
              <details key={parent.dataset} open>
                <summary>
                  {displayNodeName(names?.[parent.node], parent.node, t)} ·{" "}
                  {parent.port}
                </summary>
                <table>
                  <thead>
                    <tr>
                      {parent.columns.map((column) => (
                        <th key={column.name}>{column.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {parent.rows.map((row) => (
                      <tr key={row.row}>
                        {row.values.map((value, index) => (
                          <td key={parent.columns[index].name}>
                            <button
                              className="button secondary small"
                              aria-label={t("pythonParentCell")
                                .replace("{column}", parent.columns[index].name)
                                .replace("{row}", String(row.row + 1))}
                              disabled={disabled}
                              onClick={() =>
                                data.parent({
                                  dataset: parent.dataset,
                                  row: row.row,
                                  column: parent.columns[index].name,
                                })
                              }
                            >
                              {formatValue(value)}
                            </button>
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
          </div>
          {parentRows > result.page_size && (
            <Pager
              className="lineage-page nodrag"
              between
              offset={offset}
              total={parentRows}
              pageSize={result.page_size}
              onOffset={(offset) => data.page(entry.id, { offset })}
              disabled={disabled}
            />
          )}
        </>
      )}
      {source ? (
        <div className="lineage-source-location" title={result.node}>
          {displayNodeName(names?.[result.node || ""], result.node || "", t)} ·{" "}
          {t("lineageRow")} {result.row + 1}
        </div>
      ) : entry.deferred ? (
        <button
          className="text-button nodrag"
          disabled={disabled}
          onClick={data.expand}
        >
          {t("lineageExpand")}
        </button>
      ) : group ? (
        <button
          className="text-button nodrag"
          disabled={disabled}
          onClick={() =>
            data.page(group.parent, { group: group.key, offset: 0 })
          }
        >
          {t("lineageShowRows")} · {group.rows}
          <ArrowRight size={13} />
        </button>
      ) : (
        <>
          {formula && (
            <div
              className="lineage-equation"
              title={`${formula} = ${formatValue(result.value)}`}
            >
              {formula} = <strong>{formatValue(result.value)}</strong>
            </div>
          )}
          {!!result.calculation?.selection?.length && (
            <p className="lineage-card-condition">
              {result.calculation.selection.join(" · ")}
            </p>
          )}
          {python ? null : !result.complete ? (
            <p className="lineage-card-warning">
              <AlertTriangle size={14} />
              {t("lineageLimitedHint")}
            </p>
          ) : (
            <p className="lineage-card-reason">
              {query.group !== undefined ? (
                <>
                  {t("lineageRowsFor")}{" "}
                  <strong>{formatValue(result.group)}</strong>
                </>
              ) : result.total === 0 ? (
                t("lineageNoInputs")
              ) : isExplained(operation) ? (
                <>
                  {t(`${operationKeys[operation]}Reason`).replace(
                    "{count}",
                    String(
                      operation === "count" || operation === "count_distinct"
                        ? result.value
                        : result.total,
                    ),
                  )}
                </>
              ) : result.total ? (
                t("lineageInputsReason")
              ) : (
                t("lineageNoInputs")
              )}
            </p>
          )}
          {query.group !== undefined && (
            <button
              className="text-button nodrag"
              disabled={disabled}
              onClick={() =>
                data.page(entry.id, { group: undefined, offset: 0 })
              }
            >
              <ChevronLeft size={12} />
              {t("lineageAllGroups")}
            </button>
          )}
          {result.total > result.page_size && (
            <Pager
              className="lineage-page nodrag"
              between
              offset={offset}
              total={result.total}
              pageSize={result.page_size}
              onOffset={(offset) => data.page(entry.id, { offset })}
              disabled={disabled}
              count={
                <>
                  {result.total.toLocaleString()}{" "}
                  {t(result.groups ? "valueGroups" : "contributions")}
                </>
              }
            />
          )}
        </>
      )}
      {!group && !entry.deferred && (
        <button
          className="lineage-details-button nodrag"
          disabled={disabled}
          onClick={() => data.select(entry.id)}
        >
          {t(source ? "lineageSourceDetails" : "lineageCalculationDetails")}
        </button>
      )}
    </article>
  );
}
