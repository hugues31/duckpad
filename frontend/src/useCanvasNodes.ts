import { useMemo } from "react";
import { PipelineNode } from "./CanvasNode";
import { nodeStates, nodeStatus, primaryOutputCount } from "./canvasResults";
import type { CanvasProps } from "./canvasTypes";
import { warningCount } from "./ExecutionMessages";
import { nodeInterface } from "./graph";
import { nodeLabel, templateLabel, useT } from "./i18n";
import { nodeIconKind } from "./nodeAppearance";
import { displayNodeName } from "./nodeNames";
import { nodeProgress } from "./runEstimate";
import { useOptionalWorktree } from "./worktree";

export function useCanvasNodes(props: CanvasProps) {
  const t = useT();
  const worktree = useOptionalWorktree();
  const partitions =
    worktree?.snapshot?.partitions?.[worktree.environment]?.nodes;
  const connectedInputs = useMemo(
    () =>
      new Set([
        ...props.edges.map((edge) => `${edge.target}\0${edge.targetHandle}`),
        ...Object.values(props.exposedInputs || {}).map(
          (input) => `${input.node}\0${input.port}`,
        ),
      ]),
    [props.edges, props.exposedInputs],
  );
  const connectedOutputs = useMemo(
    () =>
      new Set([
        ...props.edges.map((edge) => `${edge.source}\0${edge.sourceHandle}`),
        ...Object.values(props.exposedOutputs || {}).map(
          (output) => `${output.node}\0${output.port}`,
        ),
      ]),
    [props.edges, props.exposedOutputs],
  );
  const displayNodes = useMemo(
    () =>
      props.nodes.map((node): PipelineNode => {
        const signature = nodeInterface(
          node,
          props.parsed,
          props.components,
          props.local,
        );
        const { kind, inputs, outputs } = signature;
        const states = nodeStates(props.statuses, props.prefix + node.id);
        const status = nodeStatus(
          props.statuses,
          props.prefix + node.id,
          states,
        );
        const full = props.prefix + node.id;
        const traced = Object.entries(props.lineage || {}).filter(
          ([id]) => id === full || id.startsWith(full + "::"),
        );
        const impact = traced.some(([, item]) => item.state);
        const stopped = traced.some(([, item]) => item.state === "discarded");
        const reached = traced.filter(
          ([, item]) => !["unreached", "unknown"].includes(item.state || ""),
        );
        const badge =
          traced.find(([, item]) => item.state === "discarded") ||
          reached[0] ||
          traced[0];
        const hovered =
          props.lineageHover === full ||
          props.lineageHover?.startsWith(full + "::");
        return {
          className: props.lineage
            ? traced.length
              ? `${impact ? (stopped ? "row-impact-stopped" : reached.length ? "row-impact-travelled" : "lineage-dimmed") : "lineage-traced"} ${hovered ? "lineage-hovered" : ""}`
              : "lineage-dimmed"
            : undefined,
          id: node.id,
          type: "pipeline" as const,
          position: node.position || { x: 0, y: 0 },
          selected: node.id === props.selected,
          // Transparent padding must let the link's reconnect handles receive drags.
          style: { pointerEvents: "none" },
          data: {
            lineage:
              badge && Object.hasOwn(badge[1], "value")
                ? {
                    value: badge[1].value,
                    steps: node.component ? traced.length : 0,
                  }
                : undefined,
            muted: node.muted,
            fullNode: props.prefix + node.id,
            partition: partitions?.[props.prefix + node.id],
            valueProducer: props.valueProducers?.includes(
              props.prefix + node.id,
            ),
            label: displayNodeName(
              props.names?.[props.prefix + node.id]?.slice(-1),
              nodeLabel(node, signature, t),
              t,
            ),
            kind,
            inputs,
            missingInputs: inputs.filter(
              (port, index) =>
                (!node.muted || index < outputs.length) &&
                !connectedInputs.has(`${node.id}\0${port}`),
            ),
            outputs,
            connectedOutputs: outputs.filter((port) =>
              connectedOutputs.has(`${node.id}\0${port}`),
            ),
            status,
            progress: nodeProgress(
              props.statuses.active,
              props.prefix + node.id,
            ),
            count: primaryOutputCount(
              node,
              props.prefix + node.id,
              outputs,
              props.components,
              props.statuses,
            ),
            warnings: states.reduce(
              (count, state) => count + warningCount(state.results),
              0,
            ),
            icon: nodeIconKind(node),
            ...(signature.kind === "component"
              ? {}
              : {
                  declaredIcon: signature.definition?.icon,
                  color: signature.definition?.color,
                }),
            linked: node.template
              ? templateLabel(
                  node.template,
                  props.parsed[node.template]?.label,
                  t,
                )
              : undefined,
          },
        };
      }),
    [
      props.nodes,
      props.lineage,
      props.lineageHover,
      partitions,
      connectedInputs,
      connectedOutputs,
      props.valueProducers,
      props.parsed,
      props.names,
      props.local,
      props.components,
      props.statuses,
      props.prefix,
      props.selected,
      t,
    ],
  );

  return displayNodes;
}
