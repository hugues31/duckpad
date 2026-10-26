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

export type WorkspaceTab = "flow" | "documentation" | "history";

const TABS = [
  ["flow", Workflow],
  ["documentation", BookOpen],
  ["history", Activity],
] as const;

export function FlowToolbar({
  readOnly,
  onProjectSettings,
  tab,
  saving,
  branch,
  active,
  canRun,
  onTab,
  onFiles,
  onMerge,
  onRun,
  onStop,
}: {
  readOnly: boolean;
  onProjectSettings: () => void;
  tab: WorkspaceTab;
  saving: boolean;
  branch: string;
  active: Json | null;
  canRun: boolean;
  onTab: (tab: WorkspaceTab) => void;
  onFiles: () => void;
  onMerge: () => void;
  onRun: () => void;
  onStop: () => void;
}) {
  const t = useT();
  return (
    <div className="flow-toolbar">
      <div className="tabs main-tabs">
        {TABS.map(([key, Icon]) => (
          <button
            key={key}
            className={tab === key ? "active" : ""}
            aria-pressed={tab === key}
            onClick={() => onTab(key)}
          >
            <Icon size={15} />
            {t(key)}
          </button>
        ))}
      </div>
      <div className="row gap">
        <button className="button secondary small" onClick={onProjectSettings}>
          <Settings2 size={14} />
          {t("projectSettings")}
        </button>
        <span className="save-status">
          {saving ? (
            <Loader2 size={13} className="spin" />
          ) : (
            <Check size={13} />
          )}{" "}
          {t(saving ? "saving" : "saved")}
        </span>
        <button className="icon" title={t("files")} onClick={onFiles}>
          <FileCode2 size={16} />
        </button>
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
