import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  AlertCircle,
  Ban,
  Boxes,
  Check,
  Clock3,
  Code2,
  FileInput,
  FileOutput,
  Filter,
  GitMerge,
  Link,
  Loader2,
  Sigma,
  Square,
  type LucideProps,
} from "lucide-react";
import { memo, useEffect } from "react";
import { PythonIcon } from "./AddIcon";
import { WarningBadge } from "./ExecutionMessages";
import { useT } from "./i18n";
import type { PartitionNode } from "./partitions";
import type { TemplateKind } from "./types";

/** The icon of a template, from its ID, or of any component. */
export function NodeIcon({ kind, ...props }: LucideProps & { kind: string }) {
  // Python template IDs end with ".py", whatever their name says.
  if (kind === "python" || kind.endsWith(".py"))
    return <PythonIcon {...props} />;
  if (kind.includes("export")) return <FileOutput {...props} />;
  if (kind === "join") return <GitMerge {...props} />;
  if (kind === "filter") return <Filter {...props} />;
  if (kind === "aggregate" || kind.includes("metrics"))
    return <Sigma {...props} />;
  if (kind.startsWith("load_")) return <FileInput {...props} />;
  if (kind === "component") return <Boxes {...props} />;
  return <Code2 {...props} />;
}

function StatusIcon({ status, ...props }: LucideProps & { status: string }) {
  if (status === "valid" || status === "success") return <Check {...props} />;
  if (status === "running" || status === "preparing")
    return <Loader2 {...props} />;
  if (status === "stale") return <Clock3 {...props} />;
  if (status === "blocked") return <Ban {...props} />;
  if (status === "failed") return <AlertCircle {...props} />;
  return <Square {...props} />;
}

/** What the canvas shows of a node. */
type PipelineData = {
  count?: number;
  fullNode: string;
  valueProducer?: boolean;
  label: string;
  kind: TemplateKind | "component";
  inputs: string[];
  missingInputs: string[];
  outputs: string[];
  /** Outputs that feed another node or the outputs of the opened component. */
  connectedOutputs: string[];
  /** The run or result state shown on the node, if any. */
  status:
    | ""
    | "valid"
    | "success"
    | "stale"
    | "failed"
    | "blocked"
    | "canceled"
    | "running";
  /** The template ID, or "component". */
  icon: string;
  linked?: string;
  warnings: number;
  partition?: PartitionNode;
};

export type PipelineNode = Node<PipelineData, "pipeline">;

export const PipelineNode = memo(function PipelineNode({
  id,
  data,
  selected,
}: NodeProps<PipelineNode>) {
  const t = useT();
  const partition = data.partition;
  const updateNodeInternals = useUpdateNodeInternals();
  const portLayout = JSON.stringify([data.kind, data.inputs, data.outputs]);
  useEffect(() => {
    // SQL edits can rename or move handles without resizing the node.
    updateNodeInternals(id);
  }, [id, portLayout, updateNodeInternals]);
  const source = data.kind === "source";
  const StatusTag = data.status === "failed" ? "button" : "span";
  const portPosition = (index: number, count: number) => {
    const spacing = Math.min(24, 72 / Math.max(1, count - 1));
    const top = 48 + (index - (count - 1) / 2) * spacing;
    const inset = source ? 27 : 75 - Math.sqrt(48 ** 2 - (top - 48) ** 2);
    return { top, inset };
  };
  return (
    <div
      className={`pipeline-node ${source ? "source-node" : "round-node"} ${data.kind} ${selected ? "is-selected" : ""}`}
    >
      <div className="node-shape">
        <NodeIcon kind={data.icon} size={27} strokeWidth={1.6} />
      </div>
      <div className="node-title" title={data.label}>
        {data.label}
      </div>
      {data.linked && (
        <div
          className="node-link-badge"
          title={`${t("linkedNode")}: ${data.linked}`}
        >
          <Link size={11} />
          {data.linked}
        </div>
      )}
      {partition && (partition.partitioned || partition.collect.length > 0) && (
        <span className="node-partition-badge">
          {partition.collect.length
            ? t("partitionCollector")
            : `${partition.dimension} · ${Object.keys(partition.filters).length ? t("partitionFiltered") : t("partitionInherited")}`}
        </span>
      )}
      <div className="node-status-slot">
        {data.valueProducer && (
          <span className="badge neutral" title={t("valueProducer")}>
            ƒ
          </span>
        )}
        <WarningBadge count={data.warnings} />
        {(data.status === "valid" || data.status === "success") &&
          data.count != null && (
            <span className="node-row-count">
              {data.count.toLocaleString()}{" "}
              {t(data.count === 1 ? "row" : "rows")}
            </span>
          )}
        {data.status &&
          data.status !== "valid" &&
          data.status !== "success" && (
            <StatusTag
              className={`node-status ${data.status}`}
              title={t(data.status)}
            >
              <StatusIcon
                status={data.status}
                size={13}
                className={data.status === "running" ? "spin" : ""}
                aria-hidden="true"
              />
              <span>{t(data.status)}</span>
            </StatusTag>
          )}
      </div>
      {data.inputs.map((port: string, i: number) => (
        <Handle
          key={"in" + port}
          type="target"
          position={Position.Left}
          id={port}
          style={{
            top: portPosition(i, data.inputs.length).top,
            left: portPosition(i, data.inputs.length).inset,
          }}
          // A connected socket is filled; an input still waiting for a source is orange.
          className={
            data.missingInputs.includes(port) ? "missing-input" : "is-connected"
          }
          title={
            data.missingInputs.includes(port)
              ? `${t("connectSource")}: ${port}`
              : port
          }
          aria-label={`${t("inputs")}: ${port}${data.missingInputs.includes(port) ? ` · ${t("connectSource")}` : ""}`}
        >
          <span className="handle-label in">{port}</span>
        </Handle>
      ))}
      {data.outputs.map((port: string, i: number) => (
        <Handle
          key={"out" + port}
          type="source"
          position={Position.Right}
          id={port}
          style={{
            top: portPosition(i, data.outputs.length).top,
            right: portPosition(i, data.outputs.length).inset,
          }}
          className={
            data.connectedOutputs.includes(port) ? "is-connected" : undefined
          }
          title={port}
          aria-label={`${t("output")}: ${port}`}
        >
          <span className="handle-label out">{port}</span>
        </Handle>
      ))}
    </div>
  );
});
PipelineNode.displayName = "PipelineNode";
