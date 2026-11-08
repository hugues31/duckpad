import {
  Filter,
  FlaskConical,
  Loader2,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { useT } from "./i18n";
import type { FailingRows, ResultsTarget, SaveProject } from "./results";
import { SamplePopover } from "./SamplePopover";
import { ALL_ROWS, deleteView, type Sample, type View } from "./samples";
import type { FlowNode } from "./types";
import { ViewsBar } from "./ViewsBar";

export default function ResultsToolbar({
  failing,
  setOffset,
  onFailing,
  editing,
  setEditing,
  sampleLabel,
  worktree,
  environment,
  target,
  columns,
  sample,
  canEdit,
  inspected,
  change,
  setDialog,
  onAddFilter,
  order,
  views,
  view,
  onSave,
  search,
  setSearch,
  pending,
}: {
  failing: FailingRows | null;
  setOffset: import("react").Dispatch<import("react").SetStateAction<number>>;
  onFailing: (failing: FailingRows | null) => void;
  editing: boolean;
  setEditing: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  sampleLabel: any;
  worktree: string;
  environment: string;
  target: ResultsTarget;
  columns: import("./types").Column[];
  sample: Sample;
  canEdit: boolean;
  inspected: { node: FlowNode; parent?: string; fullNode: string };
  change: (next: Sample, name?: string) => void;
  setDialog: import("react").Dispatch<
    import("react").SetStateAction<"test" | "view" | null>
  >;
  onAddFilter: (condition: string) => Promise<unknown>;
  order: [string, import("./samples").SortDirection][];
  views: View[];
  view: string | undefined;
  onSave: SaveProject;
  search: string;
  setSearch: import("react").Dispatch<import("react").SetStateAction<string>>;
  pending: boolean;
}) {
  const t = useT();
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
            onClick={() => {
              setOffset(0);
              onFailing(null);
            }}
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
                  setDialog("view");
                }}
                onCreateTest={(next) => {
                  change(next);
                  setEditing(false);
                  setDialog("test");
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
            onSave={() => setDialog("view")}
            onDelete={(name) =>
              onSave((bundle) =>
                deleteView(bundle, `${target.node}:${target.port}`, name),
              )
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
          onChange={(e) => setSearch(e.target.value)}
        />
        {search && (
          <button
            className="icon"
            title={t("clear")}
            onClick={() => setSearch("")}
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
