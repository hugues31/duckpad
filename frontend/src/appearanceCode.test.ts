import { describe, expect, it } from "vitest";
import {
  lintPythonAppearance,
  pythonDirectiveCursor,
  readPythonDirective,
  withAppearance,
} from "./appearanceCode";

const SQL = `-- @label Paid orders
-- @description Keep paid orders.
-- @input source
-- @output result
SELECT * FROM {{ source }};`;

const PYTHON = `# @label Score customers
import duckpad as dp

class Score(dp.Node):
    def run(self, customers: dp.Relation) -> dp.Relation:
        return customers`;

describe("withAppearance", () => {
  it("adds the directives under the label and the description of SQL", () => {
    expect(withAppearance(SQL, "sql", { icon: "filter", color: "green" })).toBe(
      `-- @label Paid orders
-- @description Keep paid orders.
-- @icon filter
-- @color green
-- @input source
-- @output result
SELECT * FROM {{ source }};`,
    );
  });

  it("adds them as comments under the label of Python", () => {
    expect(
      withAppearance(PYTHON, "python", { icon: "brain", color: "purple" }),
    ).toBe(PYTHON.replace("\n", "\n# @icon brain\n# @color purple\n"));
  });

  it("starts code that has no label, after a shebang", () => {
    expect(withAppearance("SELECT 1;", undefined, { color: "red" })).toBe(
      "-- @color red\nSELECT 1;",
    );
    expect(
      withAppearance("#!/usr/bin/env python\nimport duckpad", "python", {
        icon: "api",
      }),
    ).toBe("#!/usr/bin/env python\n# @icon api\nimport duckpad");
    expect(withAppearance("", "sql", { icon: "table" })).toBe(
      "-- @icon table\n",
    );
  });

  it("replaces a name where it is declared, however it was written", () => {
    const code = "--@icon   Filter\n-- @label A\n  -- @color red  \nSELECT 1;";
    expect(withAppearance(code, "sql", { icon: "pivot", color: "blue" })).toBe(
      "-- @icon pivot\n-- @label A\n-- @color blue\nSELECT 1;",
    );
  });

  it("removes the directive of a name that is no longer chosen", () => {
    const styled = withAppearance(SQL, "sql", {
      icon: "filter",
      color: "green",
    });
    expect(withAppearance(styled, "sql", { color: undefined })).toBe(
      SQL.replace("-- @input", "-- @icon filter\n-- @input"),
    );
    expect(
      withAppearance(styled, "sql", { icon: undefined, color: undefined }),
    ).toBe(SQL);
    expect(withAppearance(SQL, "sql", { icon: undefined })).toBe(SQL);
  });

  it("leaves what a change does not mention, even a name Duckpad cannot show", () => {
    // The picker shows neither name of code it cannot draw or parse.
    const code =
      "-- @icon future-icon\n-- @color mauve\n-- @output r\nSELECT 1;";
    expect(withAppearance(code, "sql", { color: "green" })).toBe(
      code.replace("mauve", "green"),
    );
    expect(withAppearance(code, "sql", { icon: "sort" })).toBe(
      code.replace("future-icon", "sort"),
    );
    expect(withAppearance(code, "sql", {})).toBe(code);
  });

  it("leaves one directive of each kind, so SQL and Python agree on it", () => {
    // SQL reads the last directive, Python the first.
    const sql = "-- @icon a\n-- @icon b\n-- @output r\nSELECT 1;";
    expect(withAppearance(sql, "sql", { icon: "sort" })).toBe(
      "-- @icon sort\n-- @output r\nSELECT 1;",
    );
    const python = "# @icon a\nimport duckpad\n# @icon b";
    expect(withAppearance(python, "python", { icon: undefined })).toBe(
      "import duckpad",
    );
  });

  it("reads the lines as the server does, and keeps the ending of each", () => {
    // Python's splitlines also ends a line on a lone carriage return.
    expect(
      withAppearance("-- @icon a\rSELECT 1;\n-- x\r\n", "sql", {
        icon: "sort",
      }),
    ).toBe("-- @icon sort\rSELECT 1;\n-- x\r\n");
    expect(withAppearance("-- @label A", "sql", { icon: "key" })).toBe(
      "-- @label A\n-- @icon key",
    );
    expect(
      withAppearance("SELECT 1;\n-- @color red\n", "sql", { color: undefined }),
    ).toBe("SELECT 1;\n");
  });

  it("keeps Windows line endings and everything else of the code", () => {
    const code =
      "-- @label A\r\n-- @output r\r\nSELECT 1; -- @icon not this\r\n";
    expect(withAppearance(code, "sql", { icon: "key" })).toBe(
      "-- @label A\r\n-- @icon key\r\n-- @output r\r\nSELECT 1; -- @icon not this\r\n",
    );
  });

  it("does not take the comments of the other language for directives", () => {
    expect(withAppearance("# @icon a\nSELECT 1;", "sql", { icon: "b" })).toBe(
      "-- @icon b\n# @icon a\nSELECT 1;",
    );
    expect(
      withAppearance("-- @icon a\nimport duckpad", "python", { icon: "b" }),
    ).toBe("# @icon b\n-- @icon a\nimport duckpad");
  });
});

describe("Python directives", () => {
  it("are comments written like the label", () => {
    expect(readPythonDirective("# @icon filter")).toEqual({
      key: "icon",
      value: "filter",
      keyColumn: 4,
      valueColumn: 9,
    });
    expect(readPythonDirective("    # @color   Teal  ")).toEqual({
      key: "color",
      value: "Teal",
      keyColumn: 8,
      valueColumn: 16,
    });
    // As for the label, the server needs exactly "# @name value".
    for (const line of ["#@icon filter", "#  @icon filter", "# @icon", "x = 1"])
      expect(readPythonDirective(line)).toBeNull();
  });

  it("complete in comments only", () => {
    expect(pythonDirectiveCursor("# @")).toEqual({
      kind: "directive",
      prefix: "",
    });
    expect(pythonDirectiveCursor("  # @ic")).toEqual({
      kind: "directive",
      prefix: "ic",
    });
    expect(pythonDirectiveCursor("# @icon ")).toEqual({
      kind: "appearance",
      key: "icon",
      prefix: "",
    });
    expect(pythonDirectiveCursor("# @color pu")).toEqual({
      kind: "appearance",
      key: "color",
      prefix: "pu",
    });
    for (const before of ["@", "x = 1  # @", "# @label Na", "#@icon "])
      expect(pythonDirectiveCursor(before)).toBeNull();
  });

  it("warn about the names Duckpad cannot show", () => {
    expect(
      lintPythonAppearance(
        "# @label A\n# @icon fitler\n# @color green\n# @icon also-unknown\n",
      ),
    ).toEqual([
      {
        code: "unknownIcon",
        subject: "fitler",
        severity: "warning",
        line: 2,
        column: 9,
        endColumn: 15,
      },
    ]);
    expect(lintPythonAppearance("# @color grey")).toMatchObject([
      { code: "unknownColor", subject: "grey", line: 1 },
    ]);
    expect(lintPythonAppearance(PYTHON)).toEqual([]);
  });
});
