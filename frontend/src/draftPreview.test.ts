import { describe, expect, it } from "vitest";
import { quotedIdentifier } from "./draftPreview";
import { freshNodeCode } from "./nodeCode";
import type { Bundle, FlowNode } from "./types";

describe("quotedIdentifier", () => {
  it("keeps plain lowercase names and quotes the others", () => {
    expect(quotedIdentifier("country")).toBe("country");
    expect(quotedIdentifier("order_id")).toBe("order_id");
    expect(quotedIdentifier("Country")).toBe('"Country"');
    expect(quotedIdentifier("unit price")).toBe('"unit price"');
    expect(quotedIdentifier('say "hi"')).toBe('"say ""hi"""');
    expect(quotedIdentifier("1st")).toBe('"1st"');
  });

  it("quotes reserved words", () => {
    expect(quotedIdentifier("order")).toBe('"order"');
    expect(quotedIdentifier("group")).toBe('"group"');
    expect(quotedIdentifier("ordered")).toBe("ordered");
  });
});

describe("freshNodeCode", () => {
  const bundle = (code: string): Bundle =>
    ({ node_sql: { "nodes/new.sql": code } }) as unknown as Bundle;
  const node = { id: "new", params: {} } as unknown as FlowNode;

  it("drops the palette description of a new node's SQL", () => {
    const value = bundle(
      "-- @label SQL transform\n-- @description A reusable SQL template.\n-- @input source\n-- @output result\nSELECT * FROM {{ source }};\n",
    );
    freshNodeCode(value, node);
    expect(value.node_sql!["nodes/new.sql"]).toBe(
      "-- @label SQL transform\n-- @input source\n-- @output result\nSELECT * FROM {{ source }};\n",
    );
  });

  it("keeps code without a description and Python code", () => {
    const sql = "-- @output result\nSELECT 1; -- @description is SQL here\n";
    const value = bundle(sql);
    freshNodeCode(value, node);
    expect(value.node_sql!["nodes/new.sql"]).toBe(sql);
    const python = {
      node_sql: { "nodes/new.py": '"""-- @description"""\n' },
    } as unknown as Bundle;
    freshNodeCode(python, { ...node, language: "python" });
    expect(python.node_sql!["nodes/new.py"]).toBe('"""-- @description"""\n');
  });
});
