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
      rows?: number;
      duration?: number;
      error?: string;
      run?: string;
      skipped?: boolean;
      attempt?: NodeResult & { statements?: Statement[]; status: string };
    }
  >;
}
export interface PartitionPage extends PartitionDescription {
  entries: PartitionEntry[];
  total: number;
  next_cursor: string | null;
}
