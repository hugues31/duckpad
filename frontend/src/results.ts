import type { Snapshot, Statuses } from "./types";

export const RESULT_TABS = ["data", "columns", "tests", "log"] as const;
/** A tab of the panel; "preview" shows while the node has a preview. */
export type ResultsTab = (typeof RESULT_TABS)[number] | "preview";
export const TAB_LABELS = {
  preview: "results_preview",
  data: "results_data",
  columns: "results_columns",
  tests: "results_tests",
  log: "results_log",
} as const;

/** A dataset the panel can show: an output of the node, or one of its inputs. */
export interface ResultsTarget {
  /** The expanded ID of the node holding the dataset. */
  node: string;
  port: string;
  /** For an input of the inspected node, the input port it is connected to. */
  input?: string;
}

/** Whether an edit to the project files comes from the results panel. */
export type SaveProject = (
  change: (bundle: NonNullable<Snapshot["bundle"]>) => void,
) => Promise<unknown>;

/** The time of an ISO date, as the panel shows run times. */
export const clock = (value: string) => new Date(value).toLocaleTimeString();
export const seconds = (value: number) =>
  value < 10 ? `${value.toFixed(1)} s` : `${Math.round(value)} s`;

/** Whether the active run is computing a node, or a node inside a component instance. */
export const computing = (statuses: Statuses, fullNode: string) =>
  Object.entries(statuses.active?.nodes || {}).some(
    ([id, state]) =>
      (id === fullNode || id.startsWith(fullNode + "::")) &&
      ["pending", "running"].includes(state.status),
  );

export interface FailingRows {
  test: string;
  count?: number;
}
