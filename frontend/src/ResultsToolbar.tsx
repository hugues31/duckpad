import {
  Filter,
  FlaskConical,
  Loader2,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useState } from "react";
import { useT } from "./i18n";
import {
  outputKey,
  type FailingRows,
  type ResultsTarget,
  type SaveProject,
} from "./results";
import { SamplePopover } from "./SamplePopover";
import { ALL_ROWS, deleteView, type Sample, type View } from "./samples";
import type { Column, FlowNode } from "./types";
import { ViewsBar } from "./ViewsBar";

export default function ResultsToolbar({
  failing,
  onClearFailing,
  worktree,
  environment,
  target,
  columns,
  sample,
  canEdit,
  inspected,
  change,
  onDialog,
  onAddFilter,
  views,
  view,
  onSave,
  search,
  onSearch,
  pending,
}: {
  failing: FailingRows | null;
  onClearFailing: () => void;
  worktree: string;
  environment: string;
  target: ResultsTarget;
  columns: Column[];
  sample: Sample;
  canEdit: boolean;
  inspected: { node: FlowNode; parent?: string; fullNode: string };
  change: (next: Sample, name?: string) => void;
  onDialog: (dialog: "test" | "view") => void;
  onAddFilter: (condition: string) => Promise<unknown>;
  views: View[];
  view: string | undefined;
  onSave: SaveProject;
  search: string;
  onSearch: (search: string) => void;
  pending: boolean;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const order = sample.order || [];
  const sampleLabel = sample.rows
    ? t(
        sample.method === "random" ? "sampleRandomRows" : "sampleFirstRows",
      ).replace("{count}", sample.rows.toLocaleString())
    : t("sampleAllRows");
  return (
    <div className="results-toolbar">
      {failing ? (
        <span className="sample-chip failing">
          <FlaskConical size={12} aria-hidden="true" />
          {t("failingRowsOf").replace("{test}", failing.test)}
          <button
            className="icon"
            title={t("clear")}
            aria-label={t("clear")}
            onClick={onClearFailing}
          >
            <X size={11} />
          </button>
        </span>
      ) : (
        <>
          <div className="sample-anchor">
            <button
              className={`sample-button ${editing ? "active" : ""}`}
              aria-expanded={editing}
              onClick={() => setEditing(!editing)}
            >
              <SlidersHorizontal size={13} aria-hidden="true" />
              {t("sampleLabel").replace("{sample}", sampleLabel)}
            </button>
            {editing && (
              <SamplePopover
                worktree={worktree}
                environment={environment}
                target={target}
                columns={columns.map((c) => c.name)}
                sample={sample}
                canEdit={canEdit}
                canCreateTest={
                  inspected.node.language !== "python" &&
                  canEdit &&
                  !target.input &&
                  !inspected.node.component
                }
                onApply={(next) => {
                  change(next);
                  setEditing(false);
                }}
                onClose={() => setEditing(false)}
                onSaveView={(next) => {
                  change(next);
                  setEditing(false);
                  onDialog("view");
                }}
                onCreateTest={(next) => {
                  change(next);
                  setEditing(false);
                  onDialog("test");
                }}
                onAddFilter={async (condition) => {
                  await onAddFilter(condition);
                  setEditing(false);
                }}
              />
            )}
          </div>
          {sample.filter && (
            <span className="sample-chip">
              <Filter size={11} aria-hidden="true" />
              <code>{sample.filter}</code>
              <button
                className="icon"
                title={t("removeFilter")}
                aria-label={t("removeFilter")}
                onClick={() => change({ ...sample, filter: "" })}
              >
                <X size={11} />
              </button>
            </span>
          )}
          {order.map(([column, direction]) => (
            <span className="sample-chip" key={column}>
              {column} {direction === "desc" ? "↓" : "↑"}
              <button
                className="icon"
                title={t("removeSort")}
                aria-label={`${t("removeSort")}: ${column}`}
                onClick={() =>
                  change({
                    ...sample,
                    order: order.filter(([name]) => name !== column),
                  })
                }
              >
                <X size={11} />
              </button>
            </span>
          ))}
          <span className="spacer" />
          <ViewsBar
            views={views}
            active={view}
            sample={sample}
            canEdit={canEdit}
            onSelect={(item) =>
              change(item, item === ALL_ROWS ? undefined : (item as View).name)
            }
            onSave={() => onDialog("view")}
            onDelete={(name) =>
              onSave((bundle) => deleteView(bundle, outputKey(target), name))
            }
          />
        </>
      )}
      <div className="search results-search">
        <Search size={13} aria-hidden="true" />
        <input
          aria-label={t("searchAllColumns")}
          placeholder={t("searchAllColumns")}
          value={search}
          disabled={!!failing}
          onChange={(e) => onSearch(e.target.value)}
        />
        {search && (
          <button
            className="icon"
            title={t("clear")}
            onClick={() => onSearch("")}
          >
            <X size={12} />
          </button>
        )}
      </div>
      {pending && (
        <Loader2 size={14} className="spin" aria-label={t("loading")} />
      )}
    </div>
  );
}
