import { expect, it } from "vitest";
import {
  applyParameterChange,
  sourcePreviewParams,
} from "./inspectorParameters";
import type { FlowNode } from "./types";
import { bindTo } from "./variables";

const node = (id: string, params: FlowNode["params"] = {}): FlowNode => ({
  id,
  params,
  position: { x: 0, y: 0 },
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
