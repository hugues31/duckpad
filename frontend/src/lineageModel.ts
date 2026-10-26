import type { Json } from "./types";

export type CoverageState =
  | "step_explained"
  | "sources_reached"
  | "upstream_not_explored"
  | "unsupported_operation"
  | "no_matching_row"
  | "branch_not_selected";
export type DependencyKind = "value" | "condition" | "existence";
export interface CellRef {
  dataset: string;
  execution: string;
  row: number;
  column: string;
}
export interface LineageRole {
  id: string;
  alias: string;
  display_alias: string;
  side: string;
  kind: DependencyKind;
  dataset: string;
  execution: string;
  node: string;
  label: string;
  path: string[];
  port: string;
  column: string;
  columns: { name: string; type: string }[];
  occurrences: number;
  participations: number;
  coverage: CoverageState;
}
export interface LineageStage {
  version: 1;
  id: string;
  cell: CellRef;
  worktree: string;
  environment: string;
  project: string;
  node: string;
  label: string;
  path: string[];
  port: string;
  value: unknown;
  kind: string;
  expression: string;
  sql: string;
  coverage: {
    step: CoverageState;
    upstream: CoverageState;
    warnings: string[];
  };
  roles: LineageRole[];
  edges: { source: string; target: string; kind: DependencyKind }[];
  evidence: {
    function?: string;
    argument?: string;
    examined_rows?: number;
    retained_rows?: number;
    group_keys?: string[];
    group_values?: unknown[];
    calculations?: { expression: string; value: unknown }[];
    distinct?: boolean;
    partition?: string[];
    order?: string;
    frame?: string;
    join_pairs?: {
      aliases: string[];
      rows: (number | null)[][];
      total: number;
      limit: number;
    };
    record?: { columns: { name: string; type: string }[]; values: unknown[] };
  };
  budget: { roles: number; stages: number; seconds: number; page_size: number };
}
export interface RecordPage {
  role: string;
  offset: number;
  limit: number;
  total: number;
  columns: { name: string; type: string }[];
  records: {
    cell: CellRef;
    value: unknown;
    values: unknown[];
    participations: number;
  }[];
  groups: { key: string; value: unknown; rows: number }[];
}
export interface InvestigationStep {
  id: string;
  cell: CellRef;
  parent?: string;
  via?: string;
  depth: number;
  stage?: LineageStage;
}
export interface StageView {
  role?: string;
  group?: string;
  limit: number;
  offsets: Record<string, number>;
}
export const cellKey = (cell: CellRef) =>
  JSON.stringify([cell.dataset, cell.execution, cell.row, cell.column]);
export const asCell = (cell: Json): CellRef => ({
  dataset: cell.dataset,
  execution: cell.execution,
  row: cell.row,
  column: cell.column,
});
export function ancestry(
  steps: InvestigationStep[],
  selected: string,
): InvestigationStep[] {
  const path: InvestigationStep[] = [];
  let step = steps.find((s) => s.id === selected);
  while (step) {
    path.unshift(step);
    step = steps.find((s) => s.id === step?.parent);
  }
  return path;
}
export function investigationCoverage(
  steps: InvestigationStep[],
  id = "target",
): CoverageState {
  const stage = steps.find((s) => s.id === id)?.stage;
  if (!stage) return "upstream_not_explored";
  if (stage.coverage.step === "unsupported_operation")
    return "unsupported_operation";
  let unexplored = false;
  for (const role of stage.roles) {
    if (role.coverage !== "upstream_not_explored") continue;
    const children = steps.filter((s) => s.parent === id && s.via === role.id);
    if (children.length < role.occurrences) unexplored = true;
    for (const child of children) {
      const coverage = investigationCoverage(steps, child.id);
      if (coverage === "unsupported_operation") return coverage;
      if (coverage !== "sources_reached") unexplored = true;
    }
  }
  return unexplored ? "upstream_not_explored" : "sources_reached";
}
export function stageExplanation(
  stage: LineageStage,
  t: (key: string) => string,
): string {
  const e = stage.evidence;
  if (e.function && e.retained_rows !== undefined) {
    const groups = e.group_keys
      ?.map((key, i) => `${key} = ${String(e.group_values?.[i] ?? "NULL")}`)
      .join(", ");
    return `${t("lineageFunction_" + e.function)} · ${e.retained_rows} ${t("inputRows")} · ${e.argument}${groups ? " · " + groups : ""}`;
  }
  return t("lineageKind_" + stage.kind);
}
