import { PartitionRunMenu } from "./PartitionRunMenu";
import { PartitionSelector } from "./PartitionControls";
import ProjectTabs from "./ProjectTabs";
import RunProgress from "./RunProgress";
import {
  AlertCircle,
  ArrowRight,
  Check,
  GitMerge,
  Loader2,
  Play,
  Square,
} from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useT } from "./i18n";
import { useShell } from "./shell";
import type { Diagnostic, Run, Snapshot } from "./types";
import { sameInput, useLoadedWorktree } from "./worktree";
import { useAsyncAction } from "./useAsyncAction";

/** Room kept for the save label before the run controls move under the tabs. */
const SAVE_LABEL_RESERVE = 48;

/**
 * Stack the run controls under the tabs only when one row cannot hold both.
 * The save label shrinks instead and is left out of the decision, so autosave
 * state changes never move the canvas.
 */
function useStackedToolbar() {
  const toolbar = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const bar = toolbar.current!;
    const tabs = bar.querySelector(".main-tabs")!;
    const links = [...tabs.children];
    const controls = bar.querySelector(":scope > .row")!;
    const label = bar.querySelector(".save-status-label")!;
    const width = (element: Element) => element.getBoundingClientRect().width;
    const measure = () => {
      const style = getComputedStyle(bar);
      const needed =
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight) +
        links.reduce((total, link) => total + width(link), 0) +
        (links.length - 1) *
          (parseFloat(getComputedStyle(tabs).columnGap) || 0) +
        (parseFloat(style.columnGap) || 0) +
        width(controls) -
        width(label) +
        SAVE_LABEL_RESERVE;
      setStacked(needed > bar.clientWidth + 0.5);
    };
    measure();
    const observer = new ResizeObserver(measure);
    // Links keep their natural width, unlike the tab bar once it is stacked.
    for (const element of [bar, controls, label, ...links])
      observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { toolbar, stacked };
}

/** Tabs, save state and run controls of the open working branch. */
export function FlowToolbar() {
  const t = useT();
  const { drafts, openModal, notify } = useShell();
  const review = useAsyncAction();
  const {
    id,
    environment,
    snapshot,
    statuses: { active },
    canEdit,
    saving,
    starting,
    run,
    stop,
    settle,
  } = useLoadedWorktree();
  const dirty = drafts.dirty();
  const saveState = t(saving ? "saving" : dirty ? "unsavedChanges" : "saved");
  const { toolbar, stacked } = useStackedToolbar();
  return (
    <div ref={toolbar} className="flow-toolbar" data-stacked={stacked}>
      <ProjectTabs
        project={snapshot.worktree.project}
        worktree={id}
        environment={environment}
      />
      <div className="row gap">
        <PartitionSelector />
        <span className="save-status" title={saveState}>
          {saving ? (
            <Loader2 size={13} className="spin" />
          ) : dirty ? (
            <AlertCircle size={13} />
          ) : (
            <Check size={13} />
          )}{" "}
          <span className="save-status-label">{saveState}</span>
        </span>
        {canEdit && snapshot.worktree.branch !== "main" && (
          <button
            className="button secondary small"
            disabled={review.pending}
            onClick={() =>
              void review.run(async () => {
                try {
                  await settle();
                  openModal({ kind: "git", worktree: id, mode: "review" });
                } catch (error) {
                  notify((error as Error).message, true);
                }
              })
            }
          >
            <GitMerge size={14} />
            {t("merge")}
          </button>
        )}
        {active ? (
          <button
            className="button stop"
            title={t("cancelRunHint")}
            onClick={stop}
            disabled={!canEdit || active.status === "canceling"}
          >
            <Square size={12} fill="currentColor" />
            {t(active.status === "canceling" ? "canceling" : "stop")}
          </button>
        ) : (
          <div className="run-control">
            <button
              className="button primary"
              disabled={!canEdit || starting || !snapshot.bundle}
              aria-busy={starting}
              onClick={() => run()}
            >
              {starting ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Play size={14} fill="currentColor" />
              )}
              {t("run")}
            </button>
            <PartitionRunMenu />
          </div>
        )}
      </div>
    </div>
  );
}

/** Banners stacked under the toolbar; their count sizes the floating panels. */
export function WorkspaceNotices({
  snapshot,
  active,
  runDiagnostics,
  onResolve,
  onViewFiles,
}: {
  snapshot: Snapshot;
  active: Run | null;
  runDiagnostics: Diagnostic[];
  onResolve: () => void;
  /** Show where a diagnostic applies: its node, variable, or project files. */
  onViewFiles: (diagnostic: Diagnostic) => void;
}) {
  const t = useT();
  const diagnostics = visibleDiagnostics(snapshot, runDiagnostics);
  return (
    <>
      {(snapshot.worktree.read_only ||
        snapshot.role === "reader" ||
        snapshot.role === "operator") && (
        <div className="banner">
          <span>
            {t(
              snapshot.worktree.read_only
                ? "jobReadOnly"
                : snapshot.role === "operator"
                  ? "operatorNotice"
                  : "readerNotice",
            )}
          </span>
        </div>
      )}
      {!!snapshot.conflicts.length && (
        <div className="banner warning">
          <AlertCircle size={16} />
          <span>{t("conflictHint")}</span>
          <button
            disabled={
              snapshot.worktree.read_only ||
              snapshot.role === "reader" ||
              snapshot.role === "operator"
            }
            onClick={onResolve}
          >
            {t("resolve")}
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      {!!diagnostics.length && (
        <div className="banner error">
          <AlertCircle size={16} />
          <span>
            {diagnostics.length} · {diagnostics[0].file}:{" "}
            {diagnostics[0].message}
          </span>
          <button onClick={() => onViewFiles(diagnostics[0])}>
            {t(
              diagnostics[0].node
                ? "showNode"
                : diagnostics[0].variable
                  ? "openInVariables"
                  : "viewFiles",
            )}
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      {active && <RunProgress run={active} />}
    </>
  );
}

export const visibleDiagnostics = (
  snapshot: Snapshot,
  attempted: Diagnostic[],
) =>
  snapshot.diagnostics.filter(
    (item) =>
      item.code !== "missing_input" ||
      attempted.some((problem) => sameInput(problem, item)),
  );

export const noticeCount = (
  snapshot: Snapshot,
  active: Run | null,
  attempted: Diagnostic[],
) =>
  Number(!!snapshot.conflicts.length) +
  Number(!!visibleDiagnostics(snapshot, attempted).length) +
  Number(!!active) +
  Number(
    snapshot.worktree.read_only ||
      snapshot.role === "reader" ||
      snapshot.role === "operator",
  );
