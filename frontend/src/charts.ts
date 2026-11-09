import type { Bundle, Column, Diagnostic, Json } from "./types";

export const CHARTS_FILE = "charts.json";
/** A chart draws the whole output, and only outputs of at most this many rows. */
export const CHART_ROW_LIMIT = 5000;

/** A Vega-Lite spec as charts.json stores it. */
export type ChartSpec = Record<string, unknown>;

/** A chart as charts.json stores it. */
export interface Chart {
  name: string;
  spec: ChartSpec;
}

/** The diagnostics of charts.json: while there are any, no chart renders. */
export const chartDiagnostics = (diagnostics: Diagnostic[]) =>
  diagnostics.filter((item) => item.file === CHARTS_FILE);

/** The charts of `charts.json` declared for one stored output (`node:port`). */
export function outputCharts(
  charts: Record<string, Json> | string | null | undefined,
  key: string,
): Chart[] {
  if (!charts || typeof charts !== "object") return [];
  const list = charts[key];
  return Array.isArray(list)
    ? (list.filter(
        (chart) =>
          !!chart &&
          typeof chart === "object" &&
          !Array.isArray(chart) &&
          typeof chart.name === "string" &&
          !!chart.spec &&
          typeof chart.spec === "object" &&
          !Array.isArray(chart.spec),
      ) as unknown as Chart[])
    : [];
}

/**
 * The fields a chart encodes that the result has no column for, in order:
 * Vega-Lite would draw them as empty marks without any error.
 */
export function unknownFields(spec: ChartSpec, columns: Column[]) {
  const known = new Set(columns.map((column) => column.name));
  const fields = (part: unknown): string[] =>
    Object.values((part as { encoding?: object }).encoding || {})
      .flat()
      .map((channel: { field?: unknown }) => channel?.field)
      .filter((field): field is string => typeof field === "string");
  const layers = Array.isArray(spec.layer) ? spec.layer : [];
  return [
    ...new Set(
      [spec, ...layers].flatMap(fields).filter((field) => !known.has(field)),
    ),
  ];
}

/**
 * Add a starter bar chart of the first two columns to an output (`node:port`),
 * creating charts.json when the project has none.
 */
export function addStarterChart(
  bundle: Bundle,
  key: string,
  name: string,
  columns: Column[],
) {
  const [x, y] = columns;
  const chart = {
    name,
    spec: {
      $schema: "https://vega.github.io/schema/vega-lite/v6.json",
      mark: "bar",
      encoding: {
        ...(x && { x: { field: x.name, type: "nominal" } }),
        ...(y && { y: { field: y.name, type: "quantitative" } }),
      },
    },
  };
  const charts =
    bundle.charts && typeof bundle.charts === "object" ? bundle.charts : {};
  const list = charts[key];
  charts[key] = [...(Array.isArray(list) ? list : []), chart];
  bundle.charts = charts;
}
