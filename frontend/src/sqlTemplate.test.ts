import { describe, expect, it } from "vitest";
import {
  enclosingCall,
  inputAliases,
  lintTemplate,
  outlineTemplate,
  referencesAt,
  sqlCursor,
} from "./sqlTemplate";
// The server parses the same cases in tests/test_templates.py.
import cases from "./sqlTemplateLint.json";

const TEMPLATE = `-- @label Paid orders
-- @input source
-- @param status: text = "paid"
-- @output orders
SELECT * FROM {{ source }} WHERE status = {{ status }};
-- @output summary
SELECT COUNT(*) AS orders FROM {{ orders }};
-- @test amount_present: warning
SELECT * FROM {{ orders }} WHERE amount IS NULL;
-- @message
SELECT 'info' AS level, 'done' AS message FROM {{ summary }};`;

const codes = (text: string) =>
  lintTemplate(text).map((p) => [p.code, p.subject, p.line, p.column]);

describe("outlineTemplate", () => {
  it("lists declarations with their positions and the blocks", () => {
    const outline = outlineTemplate(TEMPLATE);
    expect(outline.label).toBe("Paid orders");
    expect(outline.declarations).toEqual([
      { kind: "input", name: "source", line: 2, column: 11 },
      {
        kind: "parameter",
        name: "status",
        line: 3,
        column: 11,
        type: "text",
        default: '"paid"',
      },
      { kind: "output", name: "orders", line: 4, column: 12 },
      { kind: "output", name: "summary", line: 6, column: 12 },
    ]);
    expect(outline.blocks.map((b) => [b.kind, b.name, b.line, b.end])).toEqual([
      [null, null, 1, 3],
      ["output", "orders", 4, 5],
      ["output", "summary", 6, 7],
      ["test", "amount_present", 8, 9],
      ["message", null, 10, 11],
    ]);
  });

  it("lets an output read earlier outputs, and checks read all of them", () => {
    const outline = outlineTemplate(TEMPLATE);
    const names = (line: number) =>
      referencesAt(outline, line).map((d) => d.name);
    expect(names(5)).toEqual(["source", "status"]);
    expect(names(7)).toEqual(["source", "status", "orders"]);
    expect(names(9)).toEqual(["source", "status", "orders", "summary"]);
  });
});

describe("lintTemplate", () => {
  it("accepts a valid template", () => {
    expect(lintTemplate(TEMPLATE)).toEqual([]);
  });

  it("locates undeclared, self and forward references", () => {
    expect(
      codes(`-- @input source
-- @output a
SELECT * FROM {{ b }} JOIN {{ a }} USING (id) JOIN {{ missing }} USING (id);
-- @output b
SELECT * FROM {{ a }};`),
    ).toEqual([
      ["undeclaredReference", "b", 3, 15],
      ["undeclaredReference", "a", 3, 28],
      ["undeclaredReference", "missing", 3, 52],
    ]);
  });

  it("reports directives, declarations and checks the server refuses", () => {
    expect(
      codes(`-- @inputs source
-- @input source
-- @param source: text
-- @param limit number
-- @param amount: money = 3
-- @param path: file(location)
-- @param schema: schema_name
-- @param table: table_name(source)
-- @output 2nd
SELECT 1;
-- @test bad name: fatal
SELECT 1;
-- @message now
-- @output z
SELECT 1;`),
    ).toEqual([
      ["unknownDirective", "inputs", 1, 5],
      ["duplicateName", "source", 2, 11],
      ["duplicateName", "source", 3, 11],
      ["invalidParameter", "limit number", 4, 11],
      ["unknownParameterType", "money", 5, 19],
      ["parameterArgument", "path", 6, 11],
      ["parameterArgument", "schema", 7, 11],
      ["parameterArgument", "table", 8, 11],
      ["invalidName", "2nd", 9, 12],
      ["invalidTestName", "bad name", 11, 10],
      ["invalidTestSeverity", "fatal", 11, 20],
      ["emptyCheck", "message", 13, 5],
      ["messageArguments", "now", 13, 13],
    ]);
  });

  it("accepts parameters bound to declared connections, schemas and inputs", () => {
    expect(
      lintTemplate(`-- @input source
-- @param connection: connection = ""
-- @param path: file(connection)
-- @param secret: secret(connection)
-- @param schema: schema_name(connection) = "public"
-- @param table: table_name(schema)
-- @param columns: column_selection(source)
-- @param amount: column(source)
-- @output result
SELECT * FROM {{ connection }}.{{ schema }}.{{ table }};`),
    ).toEqual([]);
  });

  it("warns about quoted references, which bind no value", () => {
    expect(
      lintTemplate(`-- @input source
-- @param status: text
-- @output result
SELECT * FROM {{ source }} WHERE status = '{{ status }}';`),
    ).toEqual([
      {
        code: "quotedReference",
        subject: "status",
        severity: "warning",
        line: 4,
        column: 43,
        endColumn: 57,
      },
    ]);
  });
});

describe("sqlCursor", () => {
  it("completes directives, parameter types, arguments and defaults", () => {
    expect(sqlCursor("-- @pa")).toEqual({ kind: "directive", prefix: "pa" });
    expect(sqlCursor("-- @param limit: ")).toEqual({
      kind: "parameterType",
      prefix: "",
    });
    expect(sqlCursor("-- @param path: file(con")).toEqual({
      kind: "typeArgument",
      type: "file",
      prefix: "con",
    });
    expect(sqlCursor("-- @param items: list<")).toEqual({
      kind: "typeArgument",
      type: "list",
      prefix: "",
    });
    expect(sqlCursor('-- @param connection: connection = "pg')).toEqual({
      kind: "parameterDefault",
      type: "connection",
      quoted: true,
      prefix: "pg",
    });
    expect(sqlCursor("-- @test present: w")).toEqual({
      kind: "testSeverity",
      prefix: "w",
    });
    expect(sqlCursor("-- @input sou")).toEqual({ kind: "declaration" });
  });

  it("completes references, members, casts and SQL outside strings", () => {
    expect(sqlCursor("SELECT * FROM {{ sou")).toEqual({
      kind: "reference",
      prefix: "sou",
      spaced: true,
    });
    expect(sqlCursor("FROM {{")).toEqual({
      kind: "reference",
      prefix: "",
      spaced: false,
    });
    expect(sqlCursor("SELECT o.am")).toEqual({
      kind: "member",
      owner: "o",
      prefix: "am",
    });
    expect(sqlCursor("SELECT {{ orders }}.")).toEqual({
      kind: "member",
      owner: "orders",
      prefix: "",
    });
    expect(sqlCursor("SELECT amount::DEC")).toEqual({
      kind: "cast",
      prefix: "DEC",
    });
    expect(sqlCursor("SELECT 'a -- b', str")).toEqual({
      kind: "sql",
      prefix: "str",
    });
    expect(sqlCursor("SELECT 1 -- str")).toEqual({ kind: "comment" });
    expect(sqlCursor("WHERE name = 'Par")).toEqual({ kind: "string" });
  });
});

describe("inputAliases", () => {
  it("maps aliases to the inputs they name, ignoring keywords", () => {
    expect(
      Object.fromEntries(
        inputAliases(
          "SELECT * FROM {{ orders }} o JOIN {{ customers }} AS c USING (id) JOIN {{ items }} WHERE true",
        ),
      ),
    ).toEqual({
      orders: "orders",
      o: "orders",
      customers: "customers",
      c: "customers",
      items: "items",
    });
  });
});

describe("enclosingCall", () => {
  it("finds the call and argument around the cursor", () => {
    expect(enclosingCall("SELECT round(amount, ")).toEqual({
      name: "round",
      argument: 1,
      named: [],
    });
    expect(
      enclosingCall("FROM read_csv({{ path }}, header = true, delim = ';', "),
    ).toEqual({ name: "read_csv", argument: 3, named: ["header", "delim"] });
    expect(enclosingCall("SELECT coalesce(a, f(b, c), ")).toEqual({
      name: "coalesce",
      argument: 2,
      named: [],
    });
    expect(enclosingCall("SELECT [1, ")).toBeNull();
    expect(enclosingCall("SELECT 1")).toBeNull();
  });
});

describe("lint cases shared with the server", () => {
  it.each(cases)("$name", ({ sql, errors }) => {
    expect(
      lintTemplate(sql)
        .filter((problem) => problem.severity === "error")
        .map((problem) => problem.code),
    ).toEqual(errors);
  });
});
