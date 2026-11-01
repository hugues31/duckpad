// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  ALL_ROWS,
  appendBlock,
  loadSample,
  normalizedSample,
  outputViews,
  quoteIdentifier,
  sameSample,
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

describe("samples", () => {
  beforeEach(() => localStorage.clear());

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
