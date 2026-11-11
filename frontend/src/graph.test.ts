import { describe, expect, it, vi } from "vitest";
import {
  connectInput,
  containsPython,
  formatValue,
  graphAt,
  identifier,
  nodeChoices,
  nodeInterface,
  outputSource,
  pathPrefix,
  type PathPart,
} from "./graph";
import type {
  Bundle,
  ComponentDefinition,
  FlowEdge,
  FlowNode,
  Graph,
  ParsedTemplate,
} from "./types";

const node = (id: string, fields: Partial<FlowNode> = {}): FlowNode => ({
  id,
  params: {},
  position: { x: 0, y: 0 },
  ...fields,
});

const edge = (
  source: string,
  target: string,
  targetHandle = "input",
): FlowEdge => ({
  id: `${source}-${target}-${targetHandle}`,
  source,
  sourceHandle: "output",
  target,
  targetHandle,
});

/** A component definition whose nodes instantiate the given components. */
const component = (...children: string[]): ComponentDefinition => ({
  inputs: {},
  outputs: {},
  parameters: {},
  nodes: children.map((child, index) =>
    node(`child_${index}`, { component: child }),
  ),
  edges: [],
});

const parsed: Record<string, ParsedTemplate> = {
  load_csv: {
    label: "Load CSV",
    inputs: [],
    outputs: ["output"],
    parameters: [{ name: "path", type: "file" }],
  },
  join: {
    label: "Join",
    inputs: ["left", "right"],
    outputs: ["output"],
    parameters: [{ name: "on", type: "string" }],
  },
};

describe("identifier", () => {
  it("prefixes a random 12-character hexadecimal suffix", () => {
    expect(identifier()).toMatch(/^node_[0-9a-f]{12}$/);
    expect(identifier("edge")).toMatch(/^edge_[0-9a-f]{12}$/);
  });

  it("falls back to getRandomValues where randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.set([0x00, 0x01, 0x0a, 0xab, 0xcd, 0xff]);
        return bytes;
      },
    });
    expect(identifier("node")).toBe("node_00010aabcdff");
  });
});

describe("formatValue", () => {
  it("shows null as SQL NULL", () => {
    expect(formatValue(null)).toBe("NULL");
  });

  it("serializes objects and arrays as JSON", () => {
    expect(formatValue({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    expect(formatValue([1, null])).toBe("[1,null]");
  });

  it("converts scalars to strings", () => {
    expect(formatValue(42)).toBe("42");
    expect(formatValue(false)).toBe("false");
    expect(formatValue("")).toBe("");
  });
});

describe("component paths", () => {
  const inner: Graph = { nodes: [node("inner")], edges: [] };
  const outer: Graph = {
    nodes: [node("nested", { component: "inner" })],
    edges: [],
  };
  const bundle: Bundle = {
    flow: { id: "flow", name: "Flow", nodes: [node("root")], edges: [] },
    templates: {},
    components: { outer, inner },
    documentation: {},
  };
  const path: PathPart[] = [
    { instance: "first", definition: "outer", label: "Outer" },
    { instance: "nested", definition: "inner", label: "Inner" },
  ];

  it("opens the flow when the breadcrumb is empty", () => {
    expect(graphAt(bundle, [])).toBe(bundle.flow);
    expect(pathPrefix([])).toBe("");
  });

  it("opens the definition of the last breadcrumb level", () => {
    expect(graphAt(bundle, path.slice(0, 1))).toBe(outer);
    expect(graphAt(bundle, path)).toBe(inner);
  });

  it("prefixes expanded node IDs with every opened instance", () => {
    expect(pathPrefix(path.slice(0, 1))).toBe("first::");
    expect(pathPrefix(path)).toBe("first::nested::");
  });
});

describe("outputSource", () => {
  const inner: ComponentDefinition = {
    nodes: [node("rank")],
    edges: [],
    outputs: { ranked: { node: "rank", port: "result" } },
  };
  const outer: ComponentDefinition = {
    nodes: [node("nested", { component: "inner" }), node("total")],
    edges: [],
    outputs: {
      report: { node: "nested", port: "ranked" },
      summary: { node: "total", port: "result" },
    },
  };
  const bundle: Bundle = {
    flow: {
      id: "flow",
      name: "Flow",
      nodes: [node("orders"), node("first", { component: "outer" })],
      edges: [],
    },
    templates: {},
    components: { outer, inner },
    documentation: {},
  };

  it("keeps the output of a template node", () => {
    expect(outputSource(bundle, "orders", "result")).toEqual({
      node: "orders",
      port: "result",
    });
  });

  it("follows exposed outputs through nested component instances", () => {
    expect(outputSource(bundle, "first", "report")).toEqual({
      node: "first::nested::rank",
      port: "result",
    });
    expect(outputSource(bundle, "first", "summary")).toEqual({
      node: "first::total",
      port: "result",
    });
    expect(outputSource(bundle, "first::nested", "ranked")).toEqual({
      node: "first::nested::rank",
      port: "result",
    });
  });

  it("keeps an output that the component does not expose", () => {
    expect(outputSource(bundle, "first", "missing")).toEqual({
      node: "first",
      port: "missing",
    });
  });
});

describe("nodeInterface", () => {
  it("describes a template node from its parsed template", () => {
    expect(nodeInterface({ template: "join" }, parsed)).toEqual({
      definition: parsed.join,
      kind: "transform",
      inputs: ["left", "right"],
      outputs: ["output"],
      parameters: [{ name: "on", type: "string" }],
    });
    expect(nodeInterface({ template: "load_csv" }, parsed).kind).toBe("source");
    const write = { inputs: ["source"], outputs: [], writes_external: true };
    expect(nodeInterface({ template: "write" }, { write }).kind).toBe("export");
  });

  it("describes a node whose template was removed as an empty transform", () => {
    expect(nodeInterface({ template: "missing" }, parsed)).toEqual({
      definition: undefined,
      kind: "transform",
      inputs: [],
      outputs: [],
      parameters: [],
    });
  });

  it("lists the ports and named parameters of a component definition", () => {
    const target = (node: string, param: string) => [{ node, param }];
    const definition: ComponentDefinition = {
      inputs: {
        orders: { node: "join", port: "left" },
        customers: { node: "join", port: "right" },
      },
      outputs: { enriched: { node: "join", port: "output" } },
      parameters: {
        threshold: {
          type: "number",
          default: 10,
          targets: target("filter", "threshold"),
        },
        key: { type: "string", targets: target("join", "on") },
      },
      nodes: [
        node("join", { template: "join" }),
        node("filter", { template: "filter" }),
      ],
      edges: [],
    };
    expect(
      nodeInterface({ component: "enrich" }, parsed, { enrich: definition }),
    ).toEqual({
      definition,
      kind: "component",
      inputs: ["orders", "customers"],
      outputs: ["enriched"],
      parameters: [
        {
          name: "threshold",
          type: "number",
          default: 10,
          targets: [{ node: "filter", param: "threshold" }],
        },
        {
          name: "key",
          type: "string",
          targets: [{ node: "join", param: "on" }],
        },
      ],
    });
  });

  it("describes a node whose component was removed as an empty component", () => {
    expect(nodeInterface({ component: "missing" }, parsed, {})).toEqual({
      definition: undefined,
      kind: "component",
      inputs: [],
      outputs: [],
      parameters: [],
    });
  });
});

describe("nodeChoices", () => {
  const ids = (choices: ReturnType<typeof nodeChoices>) =>
    choices.map((choice) => `${choice.kind}:${choice.id}`);

  it("offers every template and component at the top level", () => {
    const components = { a: component(), b: component("a") };
    const choices = nodeChoices(parsed, components, []);
    expect(ids(choices)).toEqual([
      "template:load_csv",
      "template:join",
      "component:a",
      "component:b",
    ]);
    expect(choices[1].signature).toEqual(
      nodeInterface({ template: "join" }, parsed),
    );
    expect(choices[3].signature).toEqual(
      nodeInterface({ component: "b" }, parsed, components),
    );
    expect(choices[1].definition).toBe(parsed.join);
    expect(choices[3].definition).toBe(components.b);
  });

  it("excludes a component that contains an opened one through another definition", () => {
    const components = {
      inner: component(),
      middle: component("inner"),
      outer: component("middle"),
      sibling: component("other"),
      other: component(),
    };
    // Inside "inner", which is opened from "outer" through "middle".
    expect(
      ids(nodeChoices({}, components, ["outer", "middle", "inner"])),
    ).toEqual(["component:sibling", "component:other"]);
    // Only "inner" is open: both of its ancestors would contain it.
    expect(ids(nodeChoices({}, components, ["inner"]))).toEqual([
      "component:sibling",
      "component:other",
    ]);
  });

  it("terminates on definitions that reference each other", () => {
    const components = {
      a: component("b"),
      b: component("a"),
      c: component(),
    };
    expect(ids(nodeChoices({}, components, ["c"]))).toEqual([
      "component:a",
      "component:b",
    ]);
  });

  it("ignores references to removed components", () => {
    const components = { a: component("removed") };
    expect(ids(nodeChoices({}, components, ["b"]))).toEqual(["component:a"]);
  });
});

describe("containsPython", () => {
  it("finds Python nodes in nested components without looping on cycles", () => {
    const components = {
      outer: { nodes: [node("inner", { component: "inner" })], edges: [] },
      inner: {
        nodes: [node("split", { language: "python" })],
        edges: [],
      },
      sql: {
        nodes: [node("filter"), node("self", { component: "sql" })],
        edges: [],
      },
    } as Record<string, ComponentDefinition>;
    expect(containsPython(components, "outer")).toBe(true);
    expect(containsPython(components, "sql")).toBe(false);
    expect(containsPython(components, "missing")).toBe(false);
  });
});

describe("connectInput", () => {
  it("adds the edge with a generated identifier", () => {
    const graph: Graph = { nodes: [], edges: [] };
    connectInput(graph, {
      source: "a",
      sourceHandle: "output",
      target: "b",
      targetHandle: "input",
    });
    expect(graph.edges).toEqual([
      {
        id: expect.stringMatching(/^edge_[0-9a-f]{12}$/),
        source: "a",
        sourceHandle: "output",
        target: "b",
        targetHandle: "input",
      },
    ]);
  });

  it("replaces the previous source of the same input", () => {
    const kept = [
      edge("a", "join", "left"),
      edge("a", "other", "right"),
      edge("x", "unrelated"),
    ];
    const graph: Graph = {
      nodes: [],
      edges: [...kept, edge("b", "join", "right")],
    };
    connectInput(graph, {
      source: "c",
      sourceHandle: "output",
      target: "join",
      targetHandle: "right",
    });
    expect(graph.edges).toHaveLength(4);
    expect(graph.edges.slice(0, 3)).toEqual(kept);
    expect(graph.edges[3]).toMatchObject({
      source: "c",
      target: "join",
      targetHandle: "right",
    });
  });
});

it("keeps a shared Python template's retained ports specific to each node", () => {
  const current = {
    language: "python",
    inputs: [],
    outputs: ["new"],
  } as ParsedTemplate;
  const retained = {
    ...current,
    outputs: ["old", "new"],
    error: "Python ports changed",
  };
  const templates = { "shared.py": current };
  const local = { first: retained, second: current };
  expect(
    nodeInterface({ id: "first", template: "shared.py" }, templates, {}, local)
      .definition,
  ).toBe(retained);
  expect(
    nodeInterface({ id: "second", template: "shared.py" }, templates, {}, local)
      .definition,
  ).toBe(current);
  expect(nodeInterface({ template: "shared.py" }, templates).outputs).toEqual([
    "new",
  ]);
});
