import { memo } from "react";
import { NodeIcon } from "./CanvasNode";
import { useT } from "./i18n";
import { colorClass } from "./nodeAppearance";
import {
  nodeAnchor,
  type DiagramNode,
  type ProjectDocumentation,
} from "./projectDocumentation";

// The canvas geometry: a 96px shape centered in a 150px wide node.
const WIDTH = 150;
const SHAPE = 96;
const CENTER = { x: WIDTH / 2, y: SHAPE / 2 };
const HEXAGON_HALF_WIDTH = 24 * Math.sqrt(3);
const HEXAGON = [
  [48, 0],
  [48 + HEXAGON_HALF_WIDTH, 24],
  [48 + HEXAGON_HALF_WIDTH, 72],
  [48, 96],
  [48 - HEXAGON_HALF_WIDTH, 72],
  [48 - HEXAGON_HALF_WIDTH, 24],
]
  .map(([x, y]) => `${x + (WIDTH - SHAPE) / 2},${y}`)
  .join(" ");
const PADDING = 24;
// Labels are wider than the shapes of the outermost nodes.
const SIDE_PADDING = 56;
const LINE_HEIGHT = 21;
const LINE_LENGTH = 19;
const ICON = 40;

/** A label on at most two lines, cut with an ellipsis. */
export function labelLines(label: string, length = LINE_LENGTH) {
  const lines: string[] = [];
  for (const word of label.split(/\s+/).filter(Boolean)) {
    const last = lines.at(-1);
    if (last !== undefined && (last + " " + word).length <= length)
      lines[lines.length - 1] = last + " " + word;
    else lines.push(word);
  }
  const kept = lines.slice(0, 2).map((line, index) => {
    const cut = line.length > length || (index === 1 && lines.length > 2);
    return cut ? line.slice(0, length - 1).trimEnd() + "…" : line;
  });
  return kept.length ? kept : [""];
}

/** Where a port sits on the side of a shape: ports share its height evenly. */
function portOffset(ports: string[], port: string) {
  const index = Math.max(ports.indexOf(port), 0);
  const step = Math.min(22, 64 / Math.max(ports.length - 1, 1));
  return (index - (ports.length - 1) / 2) * step;
}

const halfWidth = (node: DiagramNode) =>
  node.kind === "component" ? HEXAGON_HALF_WIDTH : SHAPE / 2;

/**
 * The flow as a static drawing that scales with the page and prints as
 * vectors. Each node keeps its canvas position and links to its section.
 */
export default memo(function PipelineDiagram({
  diagram,
}: {
  diagram: ProjectDocumentation["diagram"];
}) {
  const t = useT();
  if (!diagram.nodes.length) return null;
  const nodes = new Map(diagram.nodes.map((node) => [node.id, node]));
  const left = Math.min(...diagram.nodes.map((node) => node.x)) - SIDE_PADDING;
  const top = Math.min(...diagram.nodes.map((node) => node.y)) - PADDING;
  const width =
    Math.max(...diagram.nodes.map((node) => node.x)) +
    WIDTH +
    SIDE_PADDING -
    left;
  const height =
    Math.max(...diagram.nodes.map((node) => node.y)) +
    SHAPE +
    2.6 * LINE_HEIGHT +
    PADDING -
    top;
  return (
    <figure className="doc-diagram">
      <svg
        viewBox={`${left} ${top} ${width} ${height}`}
        // Wide flows scroll on screen rather than shrink until unreadable.
        style={{ minWidth: Math.min(width * 0.5, 1600) }}
        role="group"
        aria-label={t("docPipeline")}
      >
        {diagram.edges.map((edge) => {
          const source = nodes.get(edge.source)!;
          const target = nodes.get(edge.target)!;
          const x1 = source.x + CENTER.x + halfWidth(source);
          const y1 =
            source.y + CENTER.y + portOffset(source.outputs, edge.sourcePort);
          const x2 = target.x + CENTER.x - halfWidth(target);
          const y2 =
            target.y + CENTER.y + portOffset(target.inputs, edge.targetPort);
          const bend = Math.max(Math.abs(x2 - x1) / 2, 40);
          return (
            <path
              key={edge.id}
              className="doc-diagram-edge"
              d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`}
            />
          );
        })}
        {diagram.nodes.map((node) => (
          <g key={node.id} transform={`translate(${node.x} ${node.y})`}>
            <a
              href={"#" + nodeAnchor(node.id)}
              className={`doc-diagram-node ${node.kind} ${colorClass(node.color)} ${node.muted ? "is-muted" : ""}`}
            >
              {node.kind === "component" ? (
                <polygon className="doc-diagram-shape" points={HEXAGON} />
              ) : (
                <rect
                  className="doc-diagram-shape"
                  x={(WIDTH - SHAPE) / 2}
                  width={SHAPE}
                  height={SHAPE}
                  rx={node.kind === "transform" ? SHAPE / 2 : 8}
                />
              )}
              <NodeIcon
                kind={node.icon}
                icon={node.declaredIcon}
                x={CENTER.x - ICON / 2}
                y={CENTER.y - ICON / 2}
                width={ICON}
                height={ICON}
                strokeWidth={1.6}
                aria-hidden="true"
              />
              <text
                x={CENTER.x}
                y={SHAPE + LINE_HEIGHT + 2}
                textAnchor="middle"
              >
                {labelLines(node.label).map((line, index) => (
                  <tspan key={index} x={CENTER.x} dy={index ? LINE_HEIGHT : 0}>
                    {line}
                  </tspan>
                ))}
              </text>
              <title>{node.label}</title>
            </a>
          </g>
        ))}
      </svg>
    </figure>
  );
});
