import { PartitionRunMenu } from "./PartitionRunMenu";
import { PartitionSelector } from "./PartitionControls";
import ProjectTabs from "./ProjectTabs";
import {
  AlertCircle,
  ArrowRight,
  Check,
  GitMerge,
  Loader2,
  Play,
  Square,
} from "lucide-react";
import { useT } from "./i18n";
import { useShell } from "./shell";
import type { Diagnostic, Run, Snapshot } from "./types";
import { useLoadedWorktree } from "./worktree";
import { useAsyncAction } from "./useAsyncAction";

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
    flush,
  } = useLoadedWorktree();
  const dirty = drafts.dirty();
  const saveState = t(saving ? "saving" : dirty ? "unsavedChanges" : "saved");
  return (
    <div className="flow-toolbar">
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
                  await flush();
                  await drafts.persist();
                  await flush();
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
        {active?.partitions && (
          <span role="status">
            {active.partitions.completed}/{active.partitions.selected}{" "}
            {t("partitions")} · {active.partitions.failed} {t("failed")}
            {!!active.partitions.active_keys?.length &&
              ` · ${t("running")}: ${active.partitions.active_keys.map((key) => String(key.value)).join(", ")}`}
          </span>
        )}
        {active?.phase && (
          <span role="status" className="muted small">
            {active.phase === "values"
              ? t("calculatingValues")
              : t("runningConsumers")}
          </span>
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
  onResolve,
  onViewFiles,
}: {
  snapshot: Snapshot;
  active: Run | null;
  onResolve: () => void;
  /** Show where a diagnostic applies: its variable, or the project files. */
  onViewFiles: (diagnostic: Diagnostic) => void;
}) {
  const t = useT();
  const nodes = Object.values(active?.nodes || {});
  const completed = nodes.filter((n) => n.status === "success").length;
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
      {!!snapshot.diagnostics.length && (
        <div className="banner error">
          <AlertCircle size={16} />
          <span>
            {snapshot.diagnostics.length} · {snapshot.diagnostics[0].file}:{" "}
            {snapshot.diagnostics[0].message}
          </span>
          <button onClick={() => onViewFiles(snapshot.diagnostics[0])}>
            {t(
              snapshot.diagnostics[0].variable
                ? "openInVariables"
                : "viewFiles",
            )}
            <ArrowRight size={14} />
          </button>
        </div>
      )}
      {active && (
        <div className="run-progress">
          <Loader2 className="spin" size={13} />
          <span>
            {t(active.status)} · {active.environment} · {completed}/
            {nodes.length} {t("nodes")}
          </span>
          <div className="progress-track">
            <div
              style={{
                width: `${(100 * completed) / Math.max(1, nodes.length)}%`,
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}

export const noticeCount = (snapshot: Snapshot, active: Run | null) =>
  Number(!!snapshot.conflicts.length) +
  Number(!!snapshot.diagnostics.length) +
  Number(!!active) +
  Number(
    snapshot.worktree.read_only ||
      snapshot.role === "reader" ||
      snapshot.role === "operator",
  );
