import { useMemo } from "react";
import { PipelineNode } from "./CanvasNode";
import { nodeStates, nodeStatus, primaryOutputCount } from "./canvasResults";
import { CanvasProps } from "./canvasTypes";
import { warningCount } from "./ExecutionMessages";
import { nodeInterface } from "./graph";
import { nodeLabel, templateLabel, useT } from "./i18n";
import { displayNodeName } from "./nodeNames";
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
        const status = nodeStatus(props.statuses, props.prefix + node.id);
        return {
          id: node.id,
          type: "pipeline" as const,
          position: node.position || { x: 0, y: 0 },
          selected: node.id === props.selected,
          data: {
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
              (port) => !connectedInputs.has(`${node.id}\0${port}`),
            ),
            outputs,
            status,
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
            icon: node.component
              ? "component"
              : node.language === "python"
                ? "python"
                : node.preset || node.template || node.origin || "",
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
      partitions,
      connectedInputs,
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
