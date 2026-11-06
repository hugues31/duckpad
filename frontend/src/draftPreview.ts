import type { Column, Json, SqlDiagnostic } from "./types";

/** Rows read from each input of a preview; null reads every row. */
export const SAMPLE_SIZES = [100, 1000, 10000, null] as const;
export type SampleSize = (typeof SAMPLE_SIZES)[number];
export const DEFAULT_SAMPLE: SampleSize = 1000;

/** A node's outputs computed from samples of its inputs, which nothing keeps. */
export interface DraftPreview {
  node: string;
  environment: string;
  rows: SampleSize;
  inputs: {
    input: string;
    node: string;
    port: string;
    status: string;
    count: number;
    sampled: number;
  }[];
  outputs: {
    port: string;
    columns: Column[];
    rows: Json[][];
    /** Rows computed, up to the preview's limit. */
    count: number;
    /** More rows exist beyond `count`. */
    truncated: boolean;
  }[];
  skipped: { exports: number; tests: number; messages: number };
  duration: number;
}

/** An input whose upstream node has no result, which "Run ancestors" computes. */
export interface MissingInput {
  input: string;
  node: string;
  port: string;
}

/** The preview of the selected node: computing, computed or refused. */
export interface PreviewState {
  node: string;
  environment: string;
  pending: boolean;
  result?: DraftPreview;
  error?: string;
  /** Inputs to compute before previewing. */
  missing?: MissingInput[];
  /** Where the previewed code failed. */
  diagnostic?: SqlDiagnostic;
}

/** The columns of a node's inputs, from upstream results or their described code. */
export interface InputColumns {
  node: string;
  environment: string;
  inputs: {
    input: string;
    node?: string;
    port?: string;
    columns: Column[] | null;
    origin: "result" | "description" | null;
    status?: string;
    reason?: "not_connected" | "not_materialized" | null;
  }[];
}

// Reserved SQL words that a column name must quote.
const RESERVED = new Set(
  (
    "all and any array as asc between both by case cast check collate column " +
    "constraint create cross default desc distinct do else end except false " +
    "fetch for foreign from full group having in inner intersect into is join " +
    "lateral left like limit natural not null offset on only or order outer " +
    "primary qualify references right select some table then to true union " +
    "unique using when where window with"
  ).split(" "),
);

/** A column name as SQL can write it: quoted unless it is a plain lowercase name. */
export const quotedIdentifier = (name: string) =>
  /^[a-z_][a-z0-9_]*$/.test(name) && !RESERVED.has(name)
    ? name
    : `"${name.replaceAll('"', '""')}"`;
