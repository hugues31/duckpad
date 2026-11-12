// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import type { Translate } from "./i18n";
import en from "./locales/en.json";
import {
  ALL_ROWS,
  appendBlock,
  appendTest,
  deleteView,
  loadSample,
  normalizedSample,
  outputViews,
  quoteIdentifier,
  sameSample,
  saveView,
  sampleFits,
  sampleKey,
  sampleQuery,
  sampleSql,
  storeSample,
  storedView,
  suggestedTestName,
  testBlock,
  testSource,
  usesVariables,
} from "./samples";
import type { Bundle, FlowNode } from "./types";

const t: Translate = (key) => en[key];
const node = (id: string): FlowNode => ({
  id,
  params: {},
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

describe("samples", () => {
  beforeEach(() => localStorage.clear());

  it("carries filters only when the destination keeps the source columns", () => {
    const sample = { method: "first" as const, filter: "input_only = 'input'" };
    expect(sampleFits(sample, ["amount"], ["amount", "input_only"])).toBe(
      false,
    );
    expect(
      sampleFits(
        sample,
        ["amount", "input_only", "extra"],
        ["amount", "input_only"],
      ),
    ).toBe(true);
    expect(sampleFits(sample, ["amount"])).toBe(false);
    expect(sampleFits(ALL_ROWS, ["amount"])).toBe(true);
    expect(
      sampleFits({ ...ALL_ROWS, order: [["input_only", "asc"]] }, ["amount"]),
    ).toBe(false);
  });

  it("drops default settings before comparing or storing", () => {
    expect(
      normalizedSample({ method: "first", filter: "  ", order: [], seed: 4 }),
    ).toEqual({ method: "first" });
    expect(normalizedSample({ method: "random", rows: 50 })).toEqual({
      method: "random",
      rows: 50,
      seed: 0,
    });
    expect(sameSample({ method: "first", filter: "" }, ALL_ROWS)).toBe(true);
    expect(sameSample({ method: "first", rows: 10 }, ALL_ROWS)).toBe(false);
  });

  it("sends only the settings the preview API needs", () => {
    expect(sampleQuery(ALL_ROWS)).toEqual({
      method: "first",
      rows: undefined,
      seed: undefined,
      filter: undefined,
      order: undefined,
    });
    expect(
      sampleQuery({
        method: "random",
        rows: 20,
        seed: 7,
        filter: " amount > 3 ",
        order: [["amount", "desc"]],
      }),
    ).toEqual({
      method: "random",
      rows: 20,
      seed: 7,
      filter: "amount > 3",
      order: '[["amount","desc"]]',
    });
  });

  it("writes the SQL of a sample with the port reference of node code", () => {
    expect(
      sampleSql("orders", {
        method: "first",
        rows: 100,
        filter: "channel = 'Partner'",
        order: [
          ["amount", "desc"],
          ["order id", "asc"],
        ],
      }),
    ).toBe(
      "SELECT * FROM {{ orders }}\nWHERE channel = 'Partner'\nORDER BY amount DESC, \"order id\" ASC\nLIMIT 100;",
    );
    expect(sampleSql("result", { method: "random", rows: 5, seed: 3 })).toBe(
      "SELECT * FROM {{ result }}\nUSING SAMPLE reservoir(5 ROWS) REPEATABLE (3);",
    );
    expect(
      sampleSql("result", {
        method: "random",
        rows: 5,
        order: [["amount", "asc"]],
      }),
    ).toContain(") ORDER BY amount ASC;");
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
  });

  it("quotes names that are not plain identifiers or are SQL keywords", () => {
    expect(quoteIdentifier("country")).toBe("country");
    expect(quoteIdentifier("Order_ID")).toBe("Order_ID");
    expect(quoteIdentifier("unit price")).toBe('"unit price"');
    expect(quoteIdentifier("1st")).toBe('"1st"');
    for (const keyword of ["order", "Group", "pivot", "left", "returning"])
      expect(quoteIdentifier(keyword)).toBe(`"${keyword}"`);
    expect(quoteIdentifier("ordered")).toBe("ordered");
  });

  it("turns a filter into a test block appended to node code", () => {
    const block = testBlock(
      "large_amount",
      "warning",
      "orders",
      " amount > 450 ",
    );
    expect(block).toBe(
      "-- @test large_amount: warning\nSELECT * FROM {{ orders }} WHERE amount > 450;\n",
    );
    expect(appendBlock("-- @output result\nSELECT 1;\n\n\n", block)).toBe(
      "-- @output result\nSELECT 1;\n\n" + block,
    );
    expect(suggestedTestName("channel = 'Partner' AND amount > 300")).toBe(
      "channel_amount_above_300",
    );
    expect(suggestedTestName("123")).toBe("custom_check");
    expect(usesVariables("amount > {{ var.threshold }}")).toBe(true);
    expect(usesVariables("amount > 3")).toBe(false);
  });

  it("finds the source of a test block up to the next block", () => {
    const code =
      "-- @output orders\nSELECT 1;\n-- @test first: warning\nSELECT * FROM {{ orders }}\nWHERE x;\n-- @test second\nSELECT 2;\n-- @message\nSELECT 3;";
    expect(testSource(code, "first")).toBe(
      "-- @test first: warning\nSELECT * FROM {{ orders }}\nWHERE x;",
    );
    expect(testSource(code, "second")).toBe("-- @test second\nSELECT 2;");
    expect(testSource(code, "missing")).toBeNull();
  });

  it("remembers a sample per user, project, node and output", () => {
    const key = sampleKey("user", "project", "node", "orders");
    expect(loadSample(key)).toEqual({ sample: ALL_ROWS });
    storeSample(key, { method: "first", rows: 10, filter: "" }, "Large");
    expect(loadSample(key)).toEqual({
      sample: { method: "first", rows: 10 },
      view: "Large",
    });
    expect(loadSample(sampleKey("other", "project", "node", "orders"))).toEqual(
      {
        sample: ALL_ROWS,
      },
    );
    storeSample(key, ALL_ROWS);
    expect(localStorage.getItem(key)).toBeNull();
    localStorage.setItem(key, "{");
    expect(loadSample(key)).toEqual({ sample: ALL_ROWS });
  });

  it("reads the views of one output from a valid views.json", () => {
    const views = {
      "node:orders": [
        storedView("Large", { method: "first", filter: "amount > 450" }),
        { name: 3 },
        "invalid",
      ],
    };
    expect(outputViews(views, "node:orders")).toEqual([
      { name: "Large", method: "first", filter: "amount > 450" },
    ]);
    expect(outputViews(views, "node:other")).toEqual([]);
    expect(outputViews("{", "node:orders")).toEqual([]);
    expect(outputViews(null, "node:orders")).toEqual([]);
  });
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
