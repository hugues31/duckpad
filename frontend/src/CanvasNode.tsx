import {
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
  Hourglass,
  Link,
  Loader2,
  Square,
  type LucideProps,
} from "lucide-react";
import { memo, useEffect, type CSSProperties } from "react";
import { CanvasPorts, PORT_GROUP_THRESHOLD } from "./CanvasPorts";
import { WarningBadge } from "./ExecutionMessages";
import { useT, type Translate } from "./i18n";
import { colorClass } from "./nodeAppearance";
import { nodeIcon } from "./nodeIcons";
import { NodeProgressFill } from "./NodeProgressFill";
import type { PartitionNode } from "./partitions";
import { seconds } from "./results";
import { elapsedDuration, overran, type NodeProgress } from "./runEstimate";
import type { TemplateKind } from "./types";
import { useNow } from "./useNow";

/** The icon a template ID suggests, by the name `@icon` would give it. */
function defaultIcon(kind: string) {
  // Python template IDs end with ".py", whatever their name says.
  if (kind === "python" || kind.endsWith(".py")) return "python";
  if (kind.includes("export")) return "export";
  if (kind === "join") return "join";
  if (kind === "filter") return "filter";
  if (kind === "aggregate" || kind.includes("metrics")) return "aggregate";
  if (kind.startsWith("load_")) return "import";
  return "sql";
}

/**
 * The icon of a node or palette entry: the one its code declares with `@icon`,
 * else the one its template ID suggests. Components have their own.
 */
export function NodeIcon({
  kind,
  icon,
  ...props
}: LucideProps & {
  /** The template ID, "python" or "component". */
  kind: string;
  /** The declared name; an unknown one keeps the default icon. */
  icon?: string;
}) {
  if (kind === "component") return <Boxes {...props} />;
  const { name, Icon } = nodeIcon(icon) ?? nodeIcon(defaultIcon(kind))!;
  return <Icon data-icon={name} {...props} />;
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
  /** The icon and the color the node's code declares, if any. */
  declaredIcon?: string;
  color?: string;
  linked?: string;
  warnings: number;
  partition?: PartitionNode;
  /** What the active run does with the node, if it is in its scope. */
  progress?: NodeProgress;
};

export type PipelineNode = Node<PipelineData, "pipeline">;

/** Center of the 96px shape inside the 150px node (see flow.css). */
export const NODE_SHAPE_CENTER = { x: 75, y: 48 };
// A regular hexagon inscribed in the same 48px radius as circular nodes.
const HEXAGON_HALF_WIDTH = 24 * Math.sqrt(3);
// Match the 8px rounding of sources and exports, tangent to each hexagon side.
const HEXAGON_RADIUS = 8;
const HEXAGON_TRIM = HEXAGON_RADIUS / Math.sqrt(3);
const HEXAGON_VERTICES = [
  [48, 0],
  [48 + HEXAGON_HALF_WIDTH, 24],
  [48 + HEXAGON_HALF_WIDTH, 72],
  [48, 96],
  [48 - HEXAGON_HALF_WIDTH, 72],
  [48 - HEXAGON_HALF_WIDTH, 24],
];
const HEXAGON_PATH =
  HEXAGON_VERTICES.map(([x, y], index, vertices) => {
    const previous = vertices[(index + 5) % 6];
    const next = vertices[(index + 1) % 6];
    const fraction = HEXAGON_TRIM / 48;
    const before = [
      x + (previous[0] - x) * fraction,
      y + (previous[1] - y) * fraction,
    ];
    const after = [x + (next[0] - x) * fraction, y + (next[1] - y) * fraction];
    return `${index ? "L" : "M"}${before.join(",")} A${HEXAGON_RADIUS},${HEXAGON_RADIUS} 0 0 1 ${after.join(",")}`;
  }).join(" ") + " Z";
const HEXAGON_STYLE = {
  "--node-hexagon-path": `path("${HEXAGON_PATH}")`,
} as CSSProperties;

/** Ports near a rounded corner follow its circular arc. */
function hexagonInset(top: number) {
  const distance = Math.abs(top - 48);
  const straightEnd = 24 - HEXAGON_TRIM;
  const halfWidth =
    distance <= straightEnd
      ? HEXAGON_HALF_WIDTH
      : distance < 24 + HEXAGON_TRIM / 2
        ? HEXAGON_HALF_WIDTH -
          HEXAGON_RADIUS +
          Math.sqrt(HEXAGON_RADIUS ** 2 - (distance - straightEnd) ** 2)
        : Math.sqrt(3) * (48 - distance);
  return 75 - halfWidth;
}

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
  const square = data.kind === "source" || data.kind === "export";
  const component = data.kind === "component";
  const StatusTag = data.status === "failed" ? "button" : "span";
  const progress = data.progress;
  const running = progress?.phase === "running";
  const queued = progress?.phase === "queued";
  const now = useNow(running);
  const portPosition = (index: number, count: number) => {
    const spacing = Math.min(24, 72 / Math.max(1, count - 1));
    const top = 48 + (index - (count - 1) / 2) * spacing;
    const inset = square
      ? 27
      : component
        ? hexagonInset(top)
        : 75 - Math.sqrt(48 ** 2 - (top - 48) ** 2);
    return { top, inset };
  };
  // A grouped side draws its links from the oval, at the middle of the side.
  const socket = (index: number, count: number) =>
    count >= PORT_GROUP_THRESHOLD
      ? portPosition(0, 1)
      : portPosition(index, count);
  return (
    <div
      className={`pipeline-node ${square ? "square-node" : "round-node"} ${data.kind} ${colorClass(data.color)} ${selected ? "is-selected" : ""} ${data.muted ? "is-muted" : ""} ${running ? "is-running" : ""} ${queued ? "is-queued" : ""}`}
    >
      {data.muted && data.inputs.length > 0 && (
        <svg
          className="node-passthrough"
          width="150"
          height="96"
          aria-hidden="true"
        >
          {data.outputs.map((port, index) => {
            const input = socket(
              index < data.inputs.length ? index : 0,
              data.inputs.length,
            );
            const output = socket(index, data.outputs.length);
            return (
              <path
                key={port}
                d={`M ${input.inset} ${input.top} C 75 ${input.top}, 75 ${output.top}, ${150 - output.inset} ${output.top}`}
              />
            );
          })}
        </svg>
      )}
      <div className="node-shape" style={component ? HEXAGON_STYLE : undefined}>
        {component && (
          <svg className="node-hexagon" viewBox="0 0 96 96" aria-hidden="true">
            <path className="node-hexagon-ring" d={HEXAGON_PATH} />
            <path className="node-hexagon-body" d={HEXAGON_PATH} />
            <path className="node-hexagon-pulse" d={HEXAGON_PATH} />
          </svg>
        )}
        {!preview && (
          <NodeProgressFill
            progress={progress}
            status={data.status}
            now={now}
          />
        )}
        <NodeIcon
          kind={data.icon}
          icon={data.declaredIcon}
          size={48}
          strokeWidth={1.6}
        />
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
      <CanvasPorts
        type="target"
        inset={portPosition(0, 1).inset}
        preview={preview}
        ports={data.inputs.map((port, i) => ({
          type: "target",
          position: Position.Left,
          id: port,
          style: {
            top: portPosition(i, data.inputs.length).top,
            left: portPosition(i, data.inputs.length).inset,
          },
          className: data.missingInputs.includes(port)
            ? "missing-input"
            : "is-connected",
          title: data.missingInputs.includes(port)
            ? `${t("connectSource")}: ${port}`
            : port,
          "aria-label": `${t("inputs")}: ${port}${data.missingInputs.includes(port) ? ` · ${t("connectSource")}` : ""}`,
          children: <span className="handle-label in">{port}</span>,
        }))}
      />
      <CanvasPorts
        type="source"
        inset={portPosition(0, 1).inset}
        preview={preview}
        ports={data.outputs.map((port, i) => ({
          type: "source",
          position: Position.Right,
          id: port,
          style: {
            top: portPosition(i, data.outputs.length).top,
            right: portPosition(i, data.outputs.length).inset,
          },
          className: data.connectedOutputs.includes(port)
            ? "is-connected"
            : undefined,
          title: port,
          "aria-label": `${t("output")}: ${port}`,
          children: <span className="handle-label out">{port}</span>,
        }))}
      />
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
