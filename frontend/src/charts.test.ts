import { expect, it } from "vitest";
import { addStarterChart, unknownFields } from "./charts";
import type { Bundle } from "./types";

const COLUMNS = [
  { name: "region", type: "VARCHAR" },
  { name: "revenue", type: "DOUBLE" },
  { name: "orders", type: "BIGINT" },
];

it("creates charts.json with a bar chart of the first two columns, with tooltips", () => {
  const bundle = {} as Bundle;
  addStarterChart(bundle, "report::sales:result", "New chart", COLUMNS);
  expect(bundle.charts).toEqual({
    "report::sales:result": [
      {
        name: "New chart",
        spec: {
          $schema: "https://vega.github.io/schema/vega-lite/v6.json",
          mark: { type: "bar", tooltip: true },
          encoding: {
            x: { field: "region", type: "nominal" },
            y: { field: "revenue", type: "quantitative" },
          },
        },
      },
    ],
  });
});

it("lists the fields of a chart that are not columns of the result, layers and tooltips included", () => {
  expect(
    unknownFields(
      {
        mark: "bar",
        encoding: {
          x: { field: "region", type: "nominal" },
          y: { field: "revenu", type: "quantitative" },
          color: { value: "red" },
        },
        layer: [
          {
            mark: "text",
            encoding: {
              text: { field: "orders" },
              tooltip: [{ field: "region" }, { field: "margin" }],
            },
          },
        ],
      },
      COLUMNS,
    ),
  ).toEqual(["revenu", "margin"]);
  expect(
    unknownFields(
      { mark: "bar", encoding: { x: { field: "region" } } },
      COLUMNS,
    ),
  ).toEqual([]);
});

it("keeps the charts of other outputs", () => {
  const other = { name: "Orders", spec: { mark: "line" } };
  const bundle = { charts: { "orders:result": [other] } } as unknown as Bundle;
  addStarterChart(bundle, "sales:result", "New chart", COLUMNS.slice(0, 1));
  expect(bundle.charts).toEqual({
    "orders:result": [other],
    "sales:result": [
      {
        name: "New chart",
        spec: {
          $schema: "https://vega.github.io/schema/vega-lite/v6.json",
          mark: { type: "bar", tooltip: true },
          encoding: { x: { field: "region", type: "nominal" } },
        },
      },
    ],
  });
});
