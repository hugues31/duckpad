import { Link } from "react-router";
import {
  Activity,
  AlertCircle,
  ArrowRight,
  BookOpen,
  Check,
  FileCode2,
  GitMerge,
  Loader2,
  Play,
  Square,
  Settings2,
  Variable,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { useT } from "./i18n";
import {
  projectSettingsUrl,
  workspaceTabs,
  worktreeUrl,
  type WorkspaceTab,
} from "./navigation";
import { useShell } from "./shell";
import type { Diagnostic, Run, Snapshot } from "./types";
import { useLoadedWorktree } from "./worktree";

const TAB_ICONS: Record<WorkspaceTab, LucideIcon> = {
  flow: Workflow,
  code: FileCode2,
  documentation: BookOpen,
  variables: Variable,
  history: Activity,
};

/** Tabs, save state and run controls of the open working branch. */
export function FlowToolbar({ tab }: { tab: WorkspaceTab }) {
  const t = useT();
  const { drafts, openModal } = useShell();
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
  } = useLoadedWorktree();
  const dirty = drafts.dirty("worktree");
  return (
    <div className="flow-toolbar">
      <div className="tabs main-tabs">
        {workspaceTabs.map((key) => {
          const Icon = TAB_ICONS[key];
          return (
            <Link
              to={worktreeUrl(id, key, environment)}
              key={key}
              className={tab === key ? "active" : ""}
              aria-current={tab === key ? "page" : undefined}
            >
              <Icon size={15} />
              {t(key)}
            </Link>
          );
        })}
      </div>
      <div className="row gap">
        <Link
          className="button secondary small"
          to={projectSettingsUrl(snapshot.worktree.project)}
        >
          <Settings2 size={14} />
          {t("projectSettings")}
        </Link>
        <span className="save-status">
          {saving ? (
            <Loader2 size={13} className="spin" />
          ) : dirty ? (
            <AlertCircle size={13} />
          ) : (
            <Check size={13} />
          )}{" "}
          {t(saving ? "saving" : dirty ? "unsavedChanges" : "saved")}
        </span>
        {canEdit && snapshot.worktree.branch !== "main" && (
          <button
            className="button secondary small"
            onClick={() =>
              openModal({ kind: "git", worktree: id, mode: "branches" })
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
          <button
            className="button primary"
            disabled={!canEdit || starting || !snapshot.bundle}
            onClick={() => run()}
          >
            <Play size={14} fill="currentColor" />
            {t("run")}
          </button>
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
      {snapshot.role === "reader" && (
        <div className="banner">
          <span>{t("readerNotice")}</span>
        </div>
      )}
      {!!snapshot.conflicts.length && (
        <div className="banner warning">
          <AlertCircle size={16} />
          <span>{t("conflictHint")}</span>
          <button disabled={snapshot.role === "reader"} onClick={onResolve}>
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
  Number(snapshot.role === "reader");
