import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { applyAssistantEvent } from "./assistantEvents";
import type { AssistantTurn } from "./assistantTypes";
import { nodeStatus } from "./canvasResults";
import {
  addFlowFilter,
  addFlowNode,
  dropFlowFiles,
  removeFlowNodes,
} from "./flowEdits";
import type { Translate } from "./i18n";
import {
  applyParameterChange,
  sourcePreviewParams,
} from "./inspectorParameters";
import en from "./locales/en.json";
import { nodeCopies, pasteNodes } from "./nodeClipboard";
import { applyPartitionDraft } from "./partitionEdits";
import { previewError } from "./previewError";
import { appendTest, deleteView, saveView } from "./samples";
import type { Bundle, FlowNode, Statuses } from "./types";
import {
  bindTo,
  variableDefaultError,
  variableNameError,
  variableProblems,
} from "./variables";
import { rememberChange, revertChange } from "./worktreeHistory";

const t: Translate = (key) => en[key];
const node = (id: string, params: FlowNode["params"] = {}): FlowNode => ({
  id,
  params,
  position: { x: 0, y: 0 },
});
const bundle = (): Bundle =>
  ({
    flow: { id: "flow", name: "Flow", nodes: [], edges: [] },
    templates: {},
    node_sql: {},
    components: {},
    documentation: {},
  }) as unknown as Bundle;

describe("worktree history", () => {
  it("caps undo, clears redo on an edit, and transfers inverse commits in both directions", async () => {
    const history = {
      undo: Array.from({ length: 100 }, (_, i) => String(i)),
      redo: ["old"],
    };
    rememberChange(history, "new");
    expect(history.undo).toHaveLength(100);
    expect(history.undo[0]).toBe("1");
    expect(history.redo).toEqual([]);
    await revertChange(history, "undo", async () => ({ change: "inverse" }));
    expect(history.redo).toEqual(["inverse"]);
    await revertChange(history, "redo", async () => ({ change: "reapplied" }));
    expect(history.undo.at(-1)).toBe("reapplied");
    expect(history.redo).toEqual([]);
  });
  it.each([409, 503])(
    "handles a rejected selected undo (%s) without disturbing later edits",
    async (status) => {
      const history = { undo: ["first", "second"], redo: [] };
      const error = new ApiError("Rejected", status);
      await expect(
        revertChange(
          history,
          "undo",
          async () => {
            throw error;
          },
          "first",
        ),
      ).rejects.toBe(error);
      expect(history.undo).toEqual(
        status === 409 ? ["second"] : ["first", "second"],
      );
      expect(history.redo).toEqual([]);
    },
  );
  it("does not request a missing undo", async () => {
    const request = vi.fn();
    expect(await revertChange({ undo: [], redo: [] }, "undo", request)).toBe(
      false,
    );
    expect(request).not.toHaveBeenCalled();
  });
});

describe("canvas status and preview errors", () => {
  it("does not borrow active or retained states from unrelated nodes", () => {
    const statuses = {
      active: { nodes: { unrelated: { status: "running" } } },
      nodes: { "other::leaf": { execution_status: "failed", outputs: {} } },
    } as unknown as Statuses;
    expect(nodeStatus(statuses, "group")).toBe("");
  });
  it.each([
    [
      {
        active: { nodes: { "group::leaf": { status: "running" } } },
        nodes: { "group::leaf": { error: "old", outputs: {} } },
      },
      "running",
    ],
    [
      {
        active: null,
        nodes: { "group::leaf": { execution_status: "blocked", outputs: {} } },
      },
      "blocked",
    ],
    [
      {
        active: null,
        nodes: { "group::leaf": { execution_status: "failed", outputs: {} } },
      },
      "failed",
    ],
    [
      {
        active: null,
        nodes: { "group::leaf": { outputs: { result: { status: "stale" } } } },
      },
      "stale",
    ],
    [
      {
        active: null,
        nodes: { "group::leaf": { outputs: { result: { status: "valid" } } } },
      },
      "valid",
    ],
    [
      {
        active: null,
        nodes: { "group::leaf": { execution_status: "success", outputs: {} } },
      },
      "success",
    ],
  ] as const)("summarizes nested node states", (statuses, expected) =>
    expect(nodeStatus(statuses as unknown as Statuses, "group")).toBe(expected),
  );
  it("keeps structured missing inputs and diagnostics and distinguishes refusal reasons", () => {
    const missing = [{ input: "data", node: "source", port: "result" }];
    const result = previewError(
      new ApiError("Busy", 409, {
        code: "run_active",
        missing,
        diagnostic: { message: "line" },
      }),
      t,
    );
    expect(result.error).toBe(en.previewRunActive);
    expect(result.missing).toBe(missing);
    expect(result.diagnostic?.message).toBe("line");
    expect(previewError(new Error("Offline"), t).error).toContain("Offline");
  });
});

it("applies assistant deltas without changing prior turns and replaces tool updates by identity", () => {
  const turn = {
    text: "Hello",
    tools: [{ id: "tool", status: "running" }],
  } as AssistantTurn;
  const text = applyAssistantEvent(turn, { type: "text", text: " world" });
  expect(text.text).toBe("Hello world");
  expect(turn.text).toBe("Hello");
  const tool = { ...turn.tools[0], status: "success" };
  const updated = applyAssistantEvent(text, { type: "tool", tool });
  expect(updated.tools).toEqual([tool]);
  expect(turn.tools[0].status).toBe("running");
  expect(
    applyAssistantEvent(updated, { type: "start", conversation: "id" }),
  ).toBe(updated);
  expect(applyAssistantEvent(updated, { type: "done", turn })).toBe(turn);
});

it("changes Inspector parameters atomically while preserving custom file labels", () => {
  const original = {
    ...node("source", {
      file: "old.csv",
      types: { amount: "INTEGER" },
      schema: "a",
      table: "b",
    }),
    label: "old.csv",
  };
  const next = applyParameterChange(original, "file", "new.csv", {
    fileSource: true,
    settings: { delimiter: ";" },
  });
  expect(next.label).toBe("new.csv");
  expect(next.params.delimiter).toBe(";");
  expect(original.params.file).toBe("old.csv");
  expect(
    applyParameterChange(
      { ...original, label: "My source" },
      "file",
      "new.csv",
      { fileSource: true },
    ).label,
  ).toBe("My source");
  expect(
    applyParameterChange(original, "header", false, { typesInPreview: true })
      .params.types,
  ).toEqual({});
  for (const types of ["invalid JSON", bindTo("column_types")]) {
    expect(
      applyParameterChange(node("source", { types }), "header", false, {
        typesInPreview: true,
      }).params.types,
    ).toEqual(types);
  }
  expect(
    applyParameterChange(node("source"), "header", false, {
      typesInPreview: true,
      parameters: [
        { name: "types", type: "json", default: { amount: "INTEGER" } },
      ],
    }).params.types,
  ).toEqual({});
  expect(
    applyParameterChange(original, "connection", "other", {
      listedConnection: "connection",
      listedSchema: "schema",
      listedTable: "table",
    }).params,
  ).toMatchObject({ schema: "", table: "" });
  expect(
    applyParameterChange(original, "schema", undefined, {
      listedSchema: "schema",
      listedTable: "table",
    }).params,
  ).not.toHaveProperty("schema");
});

it("previews literal source settings without resolving variables or expressions", () => {
  expect(
    sourcePreviewParams({ id: "control" } as FlowNode, [], false),
  ).toBeNull();
  const parameters = [
    { name: "file", type: "file", default: "default.csv" },
    { name: "header", type: "boolean", default: true },
  ];
  expect(
    sourcePreviewParams(
      node("source", {
        types: '{"amount":"INTEGER"}',
        delimiter: bindTo("delimiter"),
      }),
      parameters,
      true,
    ),
  ).toMatchObject({
    file: "default.csv",
    header: true,
    types: { amount: "INTEGER" },
  });
  expect(
    sourcePreviewParams(
      node("source", { file: "{{ var.file }}" }),
      parameters,
      true,
    ),
  ).toBeNull();
  expect(sourcePreviewParams(node("source"), parameters, false)).toBeNull();
});

it("renames partition dimensions and attributes and rejects deleting a used attribute", () => {
  const value = bundle();
  const source = node("source", { path: "{{ partition.task }}" });
  source.outputs = { result: { partition: { by: "batch", column: "batch" } } };
  value.flow.nodes = [source];
  const definition = {
    type: "text" as const,
    values: { node: "keys", column: "batch" },
    attributes: ["task"],
  };
  value.flow.partitions = { batch: definition };
  applyPartitionDraft(value, "files", definition, "task", { task: "file" }, t);
  expect(value.flow.nodes[0].params.path).toBe("{{ partition.file }}");
  expect(source.outputs.result.partition?.by).toBe("files");
  expect(value.flow.partitions.files.attributes).toEqual(["file"]);
  expect(() =>
    applyPartitionDraft(value, "files", definition, "", {}, t),
  ).toThrow(en.partitionAttributeUsed);
  expect(() =>
    applyPartitionDraft(value, "bad name", definition, "file", {}, t),
  ).toThrow(en.partitionInvalidName);
});

it("shares variable validation between declaration, rename and creation", () => {
  expect(variableNameError("bad name", [], t)).toBe(en.invalidVariableName);
  expect(variableNameError("amount", ["amount"], t)).toBe(en.variableExists);
  expect(variableDefaultError("number", "oops", t)).toContain(en.defaultValue);
  expect(
    variableProblems(
      {
        name: "amount",
        type: "choice(a|a)",
        default: "b",
        environments: { prod: "c" },
      },
      null,
      [],
      t,
    ),
  ).toEqual([
    en.choiceOptionsRequired,
    `${en.defaultValue}: ${en.invalidVariableValue.replace("{type}", "choice(a|a)")}`,
    `prod: ${en.invalidVariableValue.replace("{type}", "choice(a|a)")}`,
  ]);
  expect(
    variableProblems(
      { name: "amount", type: "number", from: { node: "", column: "amount" } },
      "amount",
      [],
      t,
    ),
  ).toContain(en.valueSourceRequired);
});

it("edits nodes and files without losing owned code, component scope or independent edges", () => {
  const value = bundle();
  value.templates.source = "-- @output result\nSELECT 1 AS amount;";
  const source = { ...node("source"), template: "source" };
  addFlowNode(value, [], source, "template", false);
  expect(source.template).toBeUndefined();
  expect(value.node_sql?.["nodes/source.sql"]).toContain("SELECT 1");
  const selected = dropFlowFiles(
    value,
    [],
    [
      {
        id: "file",
        name: "data.csv",
        path: "data.csv",
        template: "load_csv",
        code: "SELECT 2;",
        settings: { header: true },
      },
    ],
    { x: 10, y: 20 },
  );
  expect(selected).toBe("file");
  const filtered = node("filtered");
  addFlowFilter(value, [], filtered, source, "result", false, undefined);
  expect(value.flow.edges[0]).toMatchObject({
    source: "source",
    target: "filtered",
  });
  const copied = nodeCopies(value, undefined, ["source"])!;
  const [duplicate] = pasteNodes(value, undefined, copied, [], {
    detach: true,
  });
  expect(value.flow.nodes.find((n) => n.id === duplicate)?.preset).toBe(
    source.preset,
  );
  expect(value.node_sql?.[`nodes/${duplicate}.sql`]).toBe(
    value.node_sql?.["nodes/source.sql"],
  );
  removeFlowNodes(value, [], ["source"]);
  expect(value.flow.nodes.map((n) => n.id)).not.toContain("source");
  expect(value.flow.edges).toEqual([]);
  expect(value.node_sql).not.toHaveProperty("nodes/source.sql");
});

it("updates shared views and appends tests without changing linked peers when detached", () => {
  const value = bundle();
  saveView(
    value,
    "node:result",
    "Large",
    { method: "first", filter: "amount > 1" },
    t,
  );
  saveView(value, "node:result", "Large", { method: "first", rows: 10 }, t);
  expect((value.views as Record<string, unknown>)["node:result"]).toEqual([
    { name: "Large", method: "first", rows: 10 },
  ]);
  deleteView(value, "node:result", "Large");
  expect(value.views).toBeNull();
  value.templates.shared = "SELECT 1;";
  value.flow.nodes = [
    { ...node("a"), template: "shared" },
    { ...node("b"), template: "shared" },
  ];
  appendTest(
    value,
    "a",
    undefined,
    "-- @test amount: warning\nSELECT 1;",
    true,
    t,
  );
  expect(value.templates.shared).toBe("SELECT 1;");
  expect(value.flow.nodes[1].template).toBe("shared");
  expect(value.node_sql?.["nodes/a.sql"]).toContain("-- @test amount");
});
