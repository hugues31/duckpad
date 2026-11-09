import type { Snapshot, Statuses } from "./types";

export const RESULT_TABS = [
  "data",
  "chart",
  "columns",
  "tests",
  "log",
] as const;
/** A tab of the panel; "preview" shows while the node has a preview. */
export type ResultsTab = (typeof RESULT_TABS)[number] | "preview";
export const TAB_LABELS = {
  preview: "results_preview",
  data: "results_data",
  chart: "results_chart",
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

/** The key of a stored output in views.json and charts.json: `node:port`. */
export const outputKey = ({ node, port }: { node: string; port: string }) =>
  `${node}:${port}`;

/** How the panel runs the node and what it knows of its last run, for the Data and Chart tabs. */
export interface RunState {
  canEdit: boolean;
  active: boolean;
  starting?: boolean;
  onRun: () => void;
  runLabel?: string;
  /** Why the node has no result, such as the inputs a blocked collector waits for. */
  reason?: string;
  /** The panel already shows the node's last run error above the tab. */
  failureShown?: boolean;
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

/** A data test whose failing rows the Data tab shows instead of a sample. */
export interface FailingRows {
  test: string;
  count?: number;
}
