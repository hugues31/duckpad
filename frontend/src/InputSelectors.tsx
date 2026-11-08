import { nodeInterface } from "./graph";
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
      {" "}
      {!!inputs.length && (
        <>
          <h4>{t("inputs")}</h4>
          {inputs.map((port: string) => {
            const edge = graphEdges.find(
              (e) => e.target === node.id && e.targetHandle === port,
            );
            return (
              <label className="field" key={port}>
                <span>{port}</span>
                <Select
                  aria-label={port}
                  value={edge ? `${edge.source}:${edge.sourceHandle}` : ""}
                  onChange={(e) => onInput(port, e.target.value)}
                >
                  <option value="">{t("notConnected")}</option>
                  {graphNodes
                    .filter((n) => n.id !== node.id)
                    .flatMap((n) => {
                      const source = nodeInterface(
                        n,
                        snapshot.parsed_templates,
                        snapshot.bundle?.components,
                        local,
                      );
                      return source.outputs.map((p) => (
                        <option key={n.id + ":" + p} value={n.id + ":" + p}>
                          {nodeLabel(n, source, t)} · {p}
                        </option>
                      ));
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
