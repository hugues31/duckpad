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
  Hourglass,
  Link,
  Loader2,
  Sigma,
  Square,
  type LucideProps,
} from "lucide-react";
import { memo, useEffect, type ComponentProps } from "react";
import { PythonIcon } from "./AddIcon";
import { WarningBadge } from "./ExecutionMessages";
import { useT, type Translate } from "./i18n";
import { NodeProgressFill } from "./NodeProgressFill";
import type { PartitionNode } from "./partitions";
import { seconds } from "./results";
import { elapsedDuration, overran, type NodeProgress } from "./runEstimate";
import type { TemplateKind } from "./types";
import { useNow } from "./useNow";

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
  muted?: boolean;
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
  /** What the active run does with the node, if it is in its scope. */
  progress?: NodeProgress;
};

export type PipelineNode = Node<PipelineData, "pipeline">;

/** Center of the 96px shape inside the 150px node (see flow.css). */
export const NODE_SHAPE_CENTER = { x: 75, y: 48 };

export const PipelineNode = memo(function PipelineNode({
  id,
  data,
  selected,
}: NodeProps<PipelineNode>) {
  const updateNodeInternals = useUpdateNodeInternals();
  const portLayout = JSON.stringify([data.kind, data.inputs, data.outputs]);
  useEffect(() => {
    // SQL edits can rename or move handles without resizing the node.
    updateNodeInternals(id);
  }, [id, portLayout, updateNodeInternals]);
  return <PipelineNodeView data={data} selected={selected} />;
});
PipelineNode.displayName = "PipelineNode";

/** The same appearance for a canvas node and its native palette drag image. */
export function PipelineNodeView({
  data,
  selected,
  preview = false,
}: {
  data: PipelineData;
  selected?: boolean;
  preview?: boolean;
}) {
  const t = useT();
  const partition = data.partition;
  const Port = preview ? PreviewHandle : Handle;
  const square = data.kind === "source" || data.kind === "export";
  const StatusTag = data.status === "failed" ? "button" : "span";
  const progress = data.progress;
  const running = progress?.phase === "running";
  const queued = progress?.phase === "queued";
  const now = useNow(running);
  const portPosition = (index: number, count: number) => {
    const spacing = Math.min(24, 72 / Math.max(1, count - 1));
    const top = 48 + (index - (count - 1) / 2) * spacing;
    const inset = square ? 27 : 75 - Math.sqrt(48 ** 2 - (top - 48) ** 2);
    return { top, inset };
  };
  return (
    <div
      className={`pipeline-node ${square ? "square-node" : "round-node"} ${data.kind} ${selected ? "is-selected" : ""} ${data.muted ? "is-muted" : ""} ${running ? "is-running" : ""} ${queued ? "is-queued" : ""}`}
    >
      {data.muted && data.inputs.length > 0 && (
        <svg
          className="node-passthrough"
          width="150"
          height="96"
          aria-hidden="true"
        >
          {data.outputs.map((port, index) => {
            const input = portPosition(
              index < data.inputs.length ? index : 0,
              data.inputs.length,
            );
            const output = portPosition(index, data.outputs.length);
            return (
              <path
                key={port}
                d={`M ${input.inset} ${input.top} C 75 ${input.top}, 75 ${output.top}, ${150 - output.inset} ${output.top}`}
              />
            );
          })}
        </svg>
      )}
      <div className="node-shape">
        {!preview && (
          <NodeProgressFill
            progress={progress}
            status={data.status}
            now={now}
          />
        )}
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
        {data.muted && (
          <span className="badge neutral" title={t("mutedNodeHint")}>
            {t("mutedNode")}
          </span>
        )}
        {data.valueProducer && (
          <span className="badge neutral" title={t("valueProducer")}>
            ƒ
          </span>
        )}
        <WarningBadge count={data.warnings} />
        {queued ? (
          <span className="node-status pending" title={t("pendingNodeHint")}>
            <Hourglass size={13} aria-hidden="true" />
            <span>{t("pending")}</span>
          </span>
        ) : running && progress.started !== undefined ? (
          <span
            className="node-status running"
            title={runningHint(progress, now, t)}
          >
            <Loader2 size={13} className="spin" aria-hidden="true" />
            <span>{t("running")}</span>
            <span className="node-status-time">
              {elapsedDuration((now - progress.started) / 1000)}
            </span>
          </span>
        ) : (
          <>
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
          </>
        )}
      </div>
      {data.inputs.map((port: string, i: number) => (
        <Port
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
        </Port>
      ))}
      {data.outputs.map((port: string, i: number) => (
        <Port
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
        </Port>
      ))}
    </div>
  );
}

/** How long a node runs, compared with its previous duration when known. */
function runningHint(progress: NodeProgress, now: number, t: Translate) {
  const elapsed = t("runningFor").replace(
    "{duration}",
    elapsedDuration((now - progress.started!) / 1000),
  );
  const total = progress.total;
  if (!total) return `${elapsed} · ${t("noPreviousDuration")}`;
  const previous = total < 60 ? seconds(total) : elapsedDuration(total);
  return `${elapsed} · ${t(
    overran(progress, now) ? "longerThanPreviousRun" : "previousRunDuration",
  ).replace("{duration}", previous)}`;
}

/** Drag images have decorative ports, without registering live connections. */
function PreviewHandle({
  position,
  style,
  className,
  children,
}: ComponentProps<typeof Handle>) {
  return (
    <span
      className={`react-flow__handle react-flow__handle-${position} ${className || ""}`}
      style={style}
    >
      {children}
    </span>
  );
}
