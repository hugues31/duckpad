import type { Json } from "./types";

/** Samples show at most this many rows, like a preview page. */
export const MAX_SAMPLE_ROWS = 10_000;
export type SortDirection = "asc" | "desc";

/**
 * Which retained rows the results panel shows. A sample never changes what
 * runs compute: it only filters, sorts and limits the displayed rows.
 */
export interface Sample {
  method: "first" | "random";
  /** The number of rows, or all matching rows when absent. */
  rows?: number;
  seed?: number;
  /** A SQL condition on the dataset's columns, written without WHERE. */
  filter?: string;
  order?: [string, SortDirection][];
}

/** A sample shared with the project in views.json. */
export interface View extends Sample {
  name: string;
}

export const ALL_ROWS: Sample = { method: "first" };

/** The sample without its default settings, as stored and compared. */
export function normalizedSample(sample: Sample): Sample {
  const result: Sample = { method: sample.method };
  if (sample.rows) result.rows = sample.rows;
  if (sample.method === "random") result.seed = sample.seed ?? 0;
  if (sample.filter?.trim()) result.filter = sample.filter.trim();
  if (sample.order?.length) result.order = sample.order;
  return result;
}

export const sameSample = (a: Sample, b: Sample) =>
  JSON.stringify(normalizedSample(a)) === JSON.stringify(normalizedSample(b));

/** The query parameters of the preview API for a sample. */
export function sampleQuery(sample: Sample) {
  return {
    method: sample.method,
    rows: sample.rows,
    seed: sample.method === "random" ? (sample.seed ?? 0) : undefined,
    filter: sample.filter?.trim() || undefined,
    order: sample.order?.length ? JSON.stringify(sample.order) : undefined,
  };
}

/** Whether every column the sample sorts on exists, so it applies to another dataset. */
export function sampleFits(sample: Sample, columns: string[]) {
  return (sample.order || []).every(([column]) => columns.includes(column));
}

const VARIABLE = /{{\s*var\.\w+\s*}}/;

/** Whether a filter uses project variables, which node code cannot reference. */
export const usesVariables = (filter: string) => VARIABLE.test(filter);

/**
 * The SQL of a sample, written with the `{{ port }}` reference of node code
 * rather than internal table names.
 */
export function sampleSql(port: string, sample: Sample) {
  const lines = [`SELECT * FROM {{ ${port} }}`];
  const filter = sample.filter?.trim();
  if (filter) lines.push(`WHERE ${filter}`);
  const order = (sample.order || [])
    .map(
      ([column, direction]) =>
        `${quoteIdentifier(column)} ${direction.toUpperCase()}`,
    )
    .join(", ");
  if (sample.rows && sample.method === "random") {
    if (order) {
      lines.unshift("SELECT * FROM (");
      lines.push(
        `USING SAMPLE reservoir(${sample.rows} ROWS) REPEATABLE (${sample.seed ?? 0})`,
        `) ORDER BY ${order}`,
      );
    } else
      lines.push(
        `USING SAMPLE reservoir(${sample.rows} ROWS) REPEATABLE (${sample.seed ?? 0})`,
      );
  } else {
    if (order) lines.push(`ORDER BY ${order}`);
    if (sample.rows) lines.push(`LIMIT ${sample.rows}`);
  }
  return lines.join("\n") + ";";
}

/** A DuckDB identifier, quoted only when it needs to be. */
export function quoteIdentifier(name: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    ? name
    : `"${name.replaceAll('"', '""')}"`;
}

/** The `-- @test` block that turns a filter into a data test of an output. */
export function testBlock(
  name: string,
  severity: "warning" | "error",
  port: string,
  filter: string,
) {
  return `-- @test ${name}: ${severity}\nSELECT * FROM {{ ${port} }} WHERE ${filter.trim()};\n`;
}

/** Append a block to node code, separated by a blank line. */
export function appendBlock(code: string, block: string) {
  const trimmed = code.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${block}` : block;
}

/** The source of a named `-- @test` block in node code, up to the next block. */
export function testSource(code: string, name: string) {
  const lines = code.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^\\s*--\\s*@test\\s+${name}\\b`).test(line),
  );
  if (start < 0) return null;
  let end = start + 1;
  while (
    end < lines.length &&
    !/^\s*--\s*@(test|message|output)\b/.test(lines[end])
  )
    end++;
  return lines.slice(start, end).join("\n").trim();
}

export const TEST_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A test name derived from a filter, such as `amount_above_300`. */
export function suggestedTestName(filter: string) {
  const words = filter
    .toLowerCase()
    .replace(/'[^']*'/g, " ")
    .replace(/>=?/g, " above ")
    .replace(/<=?/g, " below ")
    .split(/[^a-z0-9]+/)
    .filter(
      (word) => word && !["and", "or", "not", "is", "null"].includes(word),
    )
    .slice(0, 4);
  const name = words.join("_").replace(/^[0-9_]+/, "");
  return name || "custom_check";
}

/** Personal samples are remembered in this browser, per user, node and output. */
const STORAGE_PREFIX = "duckpad-sample:";

export function sampleKey(
  user: string,
  project: string,
  node: string,
  port: string,
) {
  return `${STORAGE_PREFIX}${JSON.stringify([user, project, node, port])}`;
}

export function loadSample(key: string): { sample: Sample; view?: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || "null");
    if (
      saved &&
      (saved.sample?.method === "first" || saved.sample?.method === "random")
    )
      return saved;
  } catch {
    // An unreadable entry falls back to all rows.
  }
  return { sample: ALL_ROWS };
}

export function storeSample(key: string, sample: Sample, view?: string) {
  if (sameSample(sample, ALL_ROWS) && !view) localStorage.removeItem(key);
  else
    localStorage.setItem(
      key,
      JSON.stringify({ sample: normalizedSample(sample), view }),
    );
}

/** The views of `views.json` saved for one node output, when the file is valid. */
export function outputViews(
  views: Record<string, Json> | string | null | undefined,
  key: string,
): View[] {
  if (!views || typeof views !== "object") return [];
  const list = views[key];
  return Array.isArray(list)
    ? (
        list.filter(
          (view) =>
            !!view &&
            typeof view === "object" &&
            !Array.isArray(view) &&
            typeof view.name === "string",
        ) as unknown as View[]
      ).map((view) => ({
        ...view,
        method: view.method === "random" ? "random" : "first",
      }))
    : [];
}

/** A view as views.json stores it. */
export function storedView(name: string, sample: Sample): Json {
  return { name, ...normalizedSample(sample) } as unknown as Json;
}
