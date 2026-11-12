import { downstream, nodeInterface } from "./graph";
import { nodeLabel, useT } from "./i18n";
import Select from "./Select";
import type { FlowEdge, FlowNode, ParsedTemplate, Snapshot } from "./types";
export default function InputSelectors({
  inputs,
  graphEdges,
  node,
  graphNodes,
  snapshot,
  local,
  onInput,
}: {
  inputs: string[];
  graphEdges: FlowEdge[];
  node: FlowNode;
  graphNodes: FlowNode[];
  snapshot: Snapshot;
  local: Record<string, ParsedTemplate>;
  onInput: (port: string, source: string) => void;
}) {
  const t = useT();
  return (
    <>
      {!!inputs.length && (
        <>
          <h4>{t("inputs")}</h4>
          {inputs.map((port: string) => {
            const edge = graphEdges.find(
              (e) => e.target === node.id && e.targetHandle === port,
            );
            const current = edge ? `${edge.source}:${edge.sourceHandle}` : "";
            const cyclic = downstream(
              { nodes: graphNodes, edges: graphEdges },
              snapshot.bundle?.components ?? {},
              node.id,
              port,
            );
            return (
              <label className="field" key={port}>
                <span>{port}</span>
                <Select
                  aria-label={port}
                  value={current}
                  onChange={(e) => onInput(port, e.target.value)}
                >
                  <option value="">{t("notConnected")}</option>
                  {graphNodes.flatMap((n) => {
                    const source = nodeInterface(
                      n,
                      snapshot.parsed_templates,
                      snapshot.bundle?.components,
                      local,
                    );
                    return source.outputs.flatMap((p) => {
                      const value = n.id + ":" + p;
                      const refused = cyclic(n.id, p);
                      // A cycle saved in the project files shows until it is replaced.
                      if (refused && value !== current) return [];
                      return [
                        <option key={value} value={value} disabled={refused}>
                          {nodeLabel(n, source, t)} · {p}
                        </option>,
                      ];
                    });
                  })}
                </Select>
              </label>
            );
          })}
        </>
      )}
    </>
  );
}
