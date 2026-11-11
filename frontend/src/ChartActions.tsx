import { ChartColumn, Plus } from "lucide-react";
import { useNavigate } from "react-router";
import { addStarterChart, CHARTS_FILE, type Chart } from "./charts";
import { useT } from "./i18n";
import { codeFileUrl } from "./navigation";
import type { SaveProject } from "./results";
import type { Column } from "./types";
import { useAsyncAction } from "./useAsyncAction";

/** Pick one of the charts of an output by name, like the views bar picks a view. */
export function ChartSelector({
  charts,
  selected,
  onSelect,
}: {
  charts: Chart[];
  selected: string;
  onSelect: (name: string) => void;
}) {
  const t = useT();
  return (
    <div
      className="views-bar chart-selector"
      role="group"
      aria-label={t("chartSelector")}
    >
      {charts.map((chart) => (
        <button
          key={chart.name}
          className={`view-chip ${chart.name === selected ? "active" : ""}`}
          aria-pressed={chart.name === selected}
          onClick={() => onSelect(chart.name)}
        >
          <ChartColumn size={11} aria-hidden="true" />
          {chart.name}
        </button>
      ))}
    </div>
  );
}

/**
 * Save a starter chart for an output through the normal project save, which
 * commits it or reports a conflict, then open charts.json in the Code tab.
 */
export function AddChart({
  worktree,
  environment,
  output,
  columns,
  onSave,
}: {
  worktree: string;
  environment: string;
  /** The stored output (`node:port`) that charts.json keys the chart by. */
  output: string;
  columns: Column[];
  onSave: SaveProject;
}) {
  const t = useT();
  const navigate = useNavigate();
  const add = useAsyncAction();
  return (
    <>
      <button
        className="button primary small"
        disabled={add.pending}
        onClick={() =>
          add.run(async () => {
            await onSave((bundle) =>
              addStarterChart(bundle, output, t("chartStarterName"), columns),
            );
            await navigate(codeFileUrl(worktree, CHARTS_FILE, environment));
          })
        }
      >
        <Plus size={13} aria-hidden="true" />
        {t("chartAdd")}
      </button>
      {add.error && (
        <span className="notice error small" role="alert">
          {add.error}
        </span>
      )}
    </>
  );
}
