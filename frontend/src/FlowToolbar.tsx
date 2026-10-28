import { Link } from "react-router";
import { worktreeUrl, type WorkspaceTab } from "./navigation";
export type { WorkspaceTab } from "./navigation";
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
  Workflow,
} from "lucide-react";
import { useT } from "./i18n";
import type { Json, Snapshot } from "./types";

const TABS = [
  ["flow", Workflow],
  ["code", FileCode2],
  ["documentation", BookOpen],
  ["history", Activity],
] as const;

export function FlowToolbar({
  readOnly,
  project,
  worktree,
  environment,
  tab,
  saving,
  dirty,
  branch,
  active,
  canRun,
  onMerge,
  onRun,
  onStop,
}: {
  readOnly: boolean;
  project: string;
  worktree: string;
  environment: string;
  tab: WorkspaceTab;
  saving: boolean;
  dirty: boolean;
  branch: string;
  active: Json | null;
  canRun: boolean;
  onMerge: () => void;
  onRun: () => void;
  onStop: () => void;
}) {
  const t = useT();
  return (
    <div className="flow-toolbar">
      <div className="tabs main-tabs">
        {TABS.map(([key, Icon]) => (
          <Link
            to={worktreeUrl(worktree, key, environment)}
            key={key}
            className={tab === key ? "active" : ""}
            aria-current={tab === key ? "page" : undefined}
          >
            <Icon size={15} />
            {t(key)}
          </Link>
        ))}
      </div>
      <div className="row gap">
        <Link
          className="button secondary small"
          to={`/projects/${encodeURIComponent(project)}/settings`}
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
        {!readOnly && branch !== "main" && (
          <button className="button secondary small" onClick={onMerge}>
            <GitMerge size={14} />
            {t("merge")}
          </button>
        )}
        {active ? (
          <button
            className="button stop"
            title={t("cancelRunHint")}
            onClick={onStop}
            disabled={readOnly || active.status === "canceling"}
          >
            <Square size={12} fill="currentColor" />
            {t(active.status === "canceling" ? "canceling" : "stop")}
          </button>
        ) : (
          <button
            className="button primary"
            disabled={readOnly || !canRun}
            onClick={onRun}
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
  active: Json | null;
  onResolve: () => void;
  onViewFiles: () => void;
}) {
  const t = useT();
  const nodes = Object.values(active?.nodes || {}) as Json[];
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
            {snapshot.diagnostics.length} · {snapshot.diagnostics[0].message}
          </span>
          <button onClick={onViewFiles}>
            {t("viewFiles")}
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

export const noticeCount = (snapshot: Snapshot, active: Json | null) =>
  Number(!!snapshot.conflicts.length) +
  Number(!!snapshot.diagnostics.length) +
  Number(!!active) +
  Number(snapshot.role === "reader");
