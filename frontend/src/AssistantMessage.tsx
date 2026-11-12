import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CirclePause,
  CircleX,
  LoaderCircle,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useAssistantError } from "./assistantErrors";
import { AssistantRun, type RunControls } from "./AssistantRun";
import type {
  AssistantAction,
  AssistantTool,
  AssistantTurn,
} from "./assistantTypes";
import { useT, type TranslationKey } from "./i18n";
import MarkdownText from "./MarkdownText";

const toolLabels: Record<string, TranslationKey> = {
  read_flow: "assistantReadFlow",
  read_file: "assistantReadFile",
  read_sql: "assistantReadSql",
  read_documentation: "assistantReadDocs",
  read_guide: "assistantReadGuide",
  list_projects: "assistantListProjects",
  read_connections: "assistantReadConnections",
  read_variables: "assistantReadVariables",
  read_schemas: "assistantReadSchemas",
  read_runs: "assistantReadRuns",
  search_project: "assistantSearch",
  read_history: "assistantReadHistory",
  preview_output: "assistantPreview",
  explain_value: "assistantLineage",
  edit_flow: "assistantEditFlow",
  write_sql: "assistantWriteSql",
  write_documentation: "assistantWriteDocs",
  edit_variable: "assistantEditVariable",
  group_nodes: "assistantGroupNodes",
  edit_chart: "assistantEditChart",
  launch_run: "assistantLaunchRun",
  cancel_run: "assistantCancelRun",
  wait_for_run: "assistantWaitRun",
  inspect_run: "assistantInspectRun",
  read_run_sql: "assistantRunSql",
  compare_run: "assistantCompareRun",
};

const statusIcons: Partial<Record<TranslationKey, LucideIcon>> = {
  assistantRunConfirmation: CirclePause,
  assistantRunApproved: CircleCheck,
  assistantRunDeclined: CircleX,
  assistantReading: LoaderCircle,
  assistantComplete: CircleCheck,
  assistantStopped: CircleX,
};

export interface ActionControls extends RunControls {
  canUndo?: boolean;
  onUndo?: (action?: string) => void;
  onCompare?: (action: AssistantAction) => void;
  onConflict?: (conflict: string) => void;
}

function ToolCard({
  tool,
  canUndo,
  onUndo,
  onCompare,
  onConflict,
  canApprove,
  canCancel,
  onDecision,
}: { tool: AssistantTool } & ActionControls) {
  const t = useT();
  const action = tool.action;
  // Tools with operation-specific models nest their arguments in one object.
  const nested = (tool.args.change ?? tool.args.entry) as
    { node?: unknown; section?: unknown } | undefined;
  const target =
    tool.args.node ||
    nested?.node ||
    tool.args.path ||
    tool.args.template ||
    tool.args.section ||
    nested?.section ||
    tool.args.connection ||
    "";
  // A read outside the conversation's branch names the project and branch it comes from;
  // the internal checkout of a Job has no branch to name.
  const origin = (tool.reads ?? [])
    .filter((read) => read.project_name)
    .map((read) =>
      read.branch && !read.branch.startsWith("job:")
        ? `${read.project_name} / ${read.branch}`
        : read.project_name,
    )
    .join(", ");
  const status =
    tool.approval?.decision === null
      ? "assistantRunConfirmation"
      : tool.status === "approved"
        ? "assistantRunApproved"
        : tool.status === "denied"
          ? "assistantRunDeclined"
          : tool.status === "running"
            ? "assistantReading"
            : tool.status === "complete"
              ? "assistantComplete"
              : tool.status === "stopped"
                ? "assistantStopped"
                : "assistantFailed";
  const Icon = statusIcons[status] || CircleAlert;
  return (
    <div className="assistant-tool">
      <details open={action || tool.approval ? true : undefined}>
        <summary>
          <span className="assistant-tool-icon" data-status={status}>
            <Icon
              size={14}
              className={status === "assistantReading" ? "spin" : undefined}
            />
          </span>
          <span className="assistant-tool-label">
            {t(toolLabels[tool.name] || "assistantReadFlow")}
            {origin ? ` · ${origin}` : ""}
            {target ? ` · ${String(target)}` : ""}
          </span>
          <small>
            {t(
              action?.status === "undone"
                ? "assistantUndone"
                : action?.status === "discarded"
                  ? "assistantDiscarded"
                  : status,
            )}
          </small>
          <ChevronRight size={14} className="assistant-tool-chevron" />
        </summary>
        {tool.approval ? (
          <AssistantRun
            tool={tool}
            canApprove={canApprove}
            canCancel={canCancel}
            onDecision={onDecision}
          />
        ) : action ? (
          <>
            <ul className="assistant-changes">
              {action.changes.map((change) => (
                <li key={change.id}>
                  {t(change.status)} · {change.name}
                </li>
              ))}
            </ul>
            {action.change_count > action.changes.length && (
              <p className="muted">{t("assistantMoreChanges")}</p>
            )}
            {action.affected_nodes !== undefined && (
              <p>
                {t("assistantAffectedNodes").replace(
                  "{count}",
                  String(action.affected_nodes),
                )}
              </p>
            )}
            {action.sql_diffs.map((diff) => (
              <div key={diff.path}>
                <code>{diff.path}</code>
                <pre>{diff.diff}</pre>
                {diff.truncated && <small>{t("assistantMoreChanges")}</small>}
              </div>
            ))}
          </>
        ) : (
          <pre>{tool.summary || t(status)}</pre>
        )}
      </details>
      {action && (
        <div className="assistant-action-buttons">
          {action.commit && (
            <button
              className="button secondary small"
              onClick={() => onCompare?.(action)}
              disabled={!onCompare}
            >
              {t("compareVersions")}
            </button>
          )}
          {action.commit && action.status !== "undone" && (
            <button
              className="button secondary small"
              disabled={!canUndo || !!action.conflict}
              onClick={() => onUndo?.(action.id)}
            >
              <Undo2 size={14} />
              {t("assistantUndo")}
            </button>
          )}
          {action.conflict && (
            <button
              className="button secondary small"
              disabled={!onConflict}
              onClick={() => onConflict?.(action.conflict!)}
            >
              {t("assistantResolveConflict")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The answer is on its way: a morphing gradient orb and a shimmering label. */
export function AssistantThinking() {
  const t = useT();
  return (
    <p className="assistant-thinking" role="status">
      <span className="assistant-orb" aria-hidden="true" />
      <span className="assistant-shimmer">{t("assistantThinking")}</span>
    </p>
  );
}

export function AssistantMessage({
  turn,
  thinking = false,
  entering = false,
  ...controls
}: {
  turn: AssistantTurn;
  thinking?: boolean;
  entering?: boolean;
} & ActionControls) {
  const t = useT();
  const explainError = useAssistantError();
  const remaining = turn.tools.filter(
    (tool) => tool.action?.commit && tool.action.status === "applied",
  ).length;
  return (
    <article className={`assistant-turn${entering ? " entering" : ""}`}>
      <p className="assistant-question">{turn.user}</p>
      <div className="assistant-answer">
        {turn.tools.map((tool) => (
          <ToolCard key={tool.id} tool={tool} {...controls} />
        ))}
        {remaining > 1 && (
          <button
            className="button secondary small"
            disabled={!controls.canUndo}
            onClick={() => controls.onUndo?.()}
          >
            <Undo2 size={14} />
            {t("assistantUndoTurn").replace("{count}", String(remaining))}
          </button>
        )}
        {turn.text && (
          <div className="assistant-markdown">
            <MarkdownText>{turn.text}</MarkdownText>
          </div>
        )}
        {turn.error && (
          <p className="notice error" role="alert">
            {explainError(turn.error)}
          </p>
        )}
        {turn.status === "stopped" && (
          <p className="muted">{t("assistantStopped")}</p>
        )}
        {thinking && <AssistantThinking />}
      </div>
    </article>
  );
}
