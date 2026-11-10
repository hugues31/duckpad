import { describe, expect, it } from "vitest";
import { nodeInterface } from "./graph";
import { nodeLabel, type Translate } from "./i18n";
import fr from "./locales/fr.json";
import type { FlowNode, ParsedTemplate } from "./types";

const node: FlowNode = {
  id: "node_source",
  preset: "load_csv",
  params: {},
  position: { x: 0, y: 0 },
};
const definition: ParsedTemplate = {
  label: "Load CSV",
  inputs: [],
  outputs: ["result"],
  parameters: [],
};

describe.each([["fr", fr]] as const)("node labels in %s", (_, labels) => {
  const t: Translate = (key) => labels[key];

  it("translates ordinary, linked, and detached built-in nodes", () => {
    const normal = nodeInterface(node, {}, {}, { [node.id]: definition });
    expect(nodeLabel(node, normal, t)).toBe(labels.load_csv);
    const linked = { ...node, preset: undefined, template: "load_csv" };
    expect(
      nodeLabel(linked, nodeInterface(linked, { load_csv: definition }), t),
    ).toBe(labels.load_csv);
    const detached = { ...node, preset: undefined, origin: "load_csv" };
    expect(nodeLabel(detached, normal, t)).toBe(labels.load_csv);
  });

  it("preserves explicit names and edited template labels", () => {
    const custom = { ...definition, label: "Customer records" };
    const signature = nodeInterface(node, {}, {}, { [node.id]: custom });
    expect(nodeLabel(node, signature, t)).toBe("Customer records");
    expect(nodeLabel({ ...node, label: "Orders" }, signature, t)).toBe(
      "Orders",
    );
  });

  it("uses component names unless the instance has its own name", () => {
    const instance = { ...node, component: "revenue" };
    const signature = nodeInterface(
      instance,
      {},
      {
        revenue: {
          name: "Regional revenue",
          nodes: [],
          edges: [],
          inputs: {},
          outputs: {},
          parameters: {},
        },
      },
    );
    expect(nodeLabel(instance, signature, t)).toBe("Regional revenue");
    expect(nodeLabel({ ...instance, label: "Revenue" }, signature, t)).toBe(
      "Revenue",
    );
  });

  it("keeps the canvas fallback when the definition is unavailable", () => {
    const missing = { ...node, preset: undefined, template: "custom_source" };
    expect(nodeLabel(missing, nodeInterface(missing, {}), t)).toBe(
      "custom_source",
    );
    const sql = { ...node, preset: undefined };
    expect(nodeLabel(sql, nodeInterface(sql, {}), t)).toBe("sql");
  });
});
