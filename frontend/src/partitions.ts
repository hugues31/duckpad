import type { Json, NodeResult, Statement } from "./types";

export type PartitionType = "text" | "number" | "date" | "boolean";
export interface PartitionDefinition {
  type: PartitionType;
  values: { node: string; port?: string; column: string };
  attributes?: string[];
  execution?: { parallelism?: number; on_error?: "stop" | "continue" };
  preview?: {
    keep?: "last" | "all" | "none";
    count?: number;
    max_bytes?: number;
  };
}
export interface PartitionContext {
  manifest: string;
  partition_id?: string;
  partition_mode?: "all";
}
export interface PartitionNode {
  partitioned: boolean;
  dimension?: string;
  origin?: string;
  filters: Record<string, { by: string; column: string }>;
  collect: string[];
  error?: string;
}
export interface PartitionDescription {
  dimension: (PartitionDefinition & { name: string }) | null;
  manifest: { id: string; count: number; run: string } | null;
  nodes: Record<string, PartitionNode>;
  errors?: Record<string, string>;
}
export interface PartitionEntry {
  key_hash?: string;
  partition_id: string;
  ordinal: number;
  key: { type: PartitionType; value: string | number | boolean };
  attributes: Record<string, { type: PartitionType; value: Json }>;
  validity: "valid" | "stale" | "missing" | "failed";
  nodes: Record<
    string,
    {
      status: string;
      validity: string;
      preview_available: boolean;
      rows?: number | null;
      duration?: number | null;
      error?: string;
      run?: string;
      skipped?: boolean;
      attempt?: NodeResult & {
        statements?: Statement[];
        status: string;
        external_outcome?: string;
      };
    }
  >;
}
export interface PartitionPage extends PartitionDescription {
  entries: PartitionEntry[];
  total: number;
  next_cursor: string | null;
}

export interface PartitionLaunchOptions {
  partitions?: {
    mode: "all" | "failed" | "missing" | "selected";
    keys?: PartitionEntry["key"][];
  };
  partition_execution?: {
    parallelism?: number;
    on_error?: "stop" | "continue";
  };
}

/** Rename bound references without changing literal SQL, keys or other parameters. */
export function renamePartitionReferences(
  value: Json,
  names: Record<string, string>,
): Json {
  if (typeof value === "string")
    return value.replace(
      /\{\{\s*partition\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
      (match, name: string) =>
        names[name] ? `{{ partition.${names[name]} }}` : match,
    );
  if (Array.isArray(value))
    return value.map((item) => renamePartitionReferences(item, names));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "$partition" && typeof item === "string"
          ? names[item] || item
          : renamePartitionReferences(item, names),
      ]),
    );
  return value;
}
