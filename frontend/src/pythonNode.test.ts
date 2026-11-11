import { describe, expect, it } from "vitest";
import { outlinePython, pythonCursor, stringPurpose } from "./pythonNode";

const NODE = `import duckpad as dp
import duckdb
from typing import ClassVar

class Split(dp.Node):
    """Split orders."""
    LIMIT: ClassVar[int] = 3
    minimum: int = dp.param(default=100, ge=0)
    column: dp.Column = dp.param(default="amount", input="orders")
    api: dp.Connection = ""

    class Outputs(dp.Outputs):
        accepted: dp.Relation
        rejected: dp.Relation

    def run(
        self, orders: dp.Relation, customers: dp.Relation
    ) -> Outputs:
        value: int = 3
        return self.Outputs(accepted=orders, rejected=customers)
`;

describe("outlinePython", () => {
  it("reads the SDK alias, parameters, inputs and outputs", () => {
    expect(outlinePython(NODE)).toEqual({
      sdk: "dp",
      duckdb: ["duckdb"],
      parameters: [
        { name: "minimum", annotation: "int", line: 8 },
        { name: "column", annotation: "dp.Column", line: 9 },
        { name: "api", annotation: "dp.Connection", line: 10 },
      ],
      inputs: ["orders", "customers"],
      outputs: ["accepted", "rejected"],
    });
  });

  it("ignores docstrings and commas inside annotations", () => {
    const outline = outlinePython(`import duckpad as dp
class A(dp.Node):
    """Split orders.

    Inputs: orders
    """
    limit: int = 3

    def run(self, orders: dp.Relation, extra: dict[str, int]) -> None:
        pass
`);
    expect(outline.parameters.map((p) => p.name)).toEqual(["limit"]);
    expect(outline.inputs).toEqual(["orders", "extra"]);
  });

  it("reads single and absent outputs", () => {
    const node = (returns: string) =>
      outlinePython(
        `import duckpad as dp\nclass A(dp.Node):\n    def run(self) -> ${returns}:\n        pass\n`,
      ).outputs;
    expect(node("dp.Relation")).toEqual(["result"]);
    expect(node("None")).toEqual([]);
  });

  it("finds nothing without the SDK import", () => {
    expect(outlinePython("class A:\n    x: int = 1\n").parameters).toEqual([]);
  });
});

describe("pythonCursor", () => {
  it("completes members after a dotted name", () => {
    expect(pythonCursor("    x = dp.Co")).toEqual({
      kind: "member",
      owner: "dp",
      prefix: "Co",
    });
    expect(pythonCursor("        rows = self.db.")).toEqual({
      kind: "member",
      owner: "self.db",
      prefix: "",
    });
  });

  it("completes keywords inside a call", () => {
    expect(pythonCursor("    limit: int = dp.param(default=3, g")).toEqual({
      kind: "keyword",
      call: "dp.param",
      prefix: "g",
      given: ["default"],
    });
  });

  it("tells what a string is for", () => {
    const cursor = pythonCursor('    column: dp.Column = dp.param(input="or');
    expect(cursor).toEqual({
      kind: "string",
      context: "    column: dp.Column = dp.param(input=",
      prefix: "or",
    });
    expect(
      stringPurpose(cursor.kind === "string" ? cursor.context : "", "dp"),
    ).toBe("input");
    expect(stringPurpose("self.message(", "dp")).toBe("level");
    expect(stringPurpose("orders.filter(col(", "dp")).toBe("column");
    expect(stringPurpose("dp.param(", "dp")).toBe("name");
    expect(pythonCursor("    # self.")).toEqual({ kind: "comment" });
  });
});
