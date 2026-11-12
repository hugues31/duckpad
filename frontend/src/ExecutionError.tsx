import { AlertCircle, Code2 } from "lucide-react";
import AskAssistant from "./AskAssistant";
import { useT } from "./i18n";
import type { NodeResult } from "./types";
import { Link } from "react-router";
import { missingFunctionExtension } from "./extensions";
import { useOptionalWorktree } from "./worktree";
import { projectPageUrl } from "./navigation";
import { partitionMessage } from "./partitions";

/** Node errors carry no code: a run whose Python policy was disabled mid-run fails with this. */
const PYTHON_DISABLED = "Python execution is disabled";

export default function ExecutionError({
  failure,
  node,
  environment,
  currentSource,
  label,
  blocked = false,
  onEditCode,
  onLog,
}: {
  failure: NodeResult;
  node: string;
  environment: string;
  currentSource: string;
  /** The failed node's name, when it is not the selected one. */
  label?: string;
  /** Whether the selected node was blocked rather than failing itself. */
  blocked?: boolean;
  onEditCode: (line?: number) => void;
  /** Absent where the log below already belongs to this failure. */
  onLog?: () => void;
}) {
  const t = useT();
  const diagnostic = failure.diagnostic;
  const current = diagnostic?.source === currentSource;
  const worktree = useOptionalWorktree();
  const extension = missingFunctionExtension(
    diagnostic?.message || failure.error || "",
  );
  // A blocked node names its culprit in the title; a component names its failed inner node.
  const title = !blocked
    ? t("lastRunFailed")
    : label
      ? t("blockedBy").replace("{node}", label)
      : t("blocked");
  return (
    <section className="execution-error" role="alert" aria-label={title}>
      <div className="row gap">
        <AlertCircle size={18} aria-hidden="true" />
        <strong>{title}</strong>
        {diagnostic && (
          <span>
            {t("errorLine").replace("{line}", String(diagnostic.line))}
          </span>
        )}
      </div>
      {label && !blocked && <p>{label}</p>}
      <pre className="execution-error-message">
        {diagnostic?.message ||
          (failure.error === PYTHON_DISABLED
            ? t("pythonExecutionDisabled")
            : partitionMessage(t, failure.error || ""))}
      </pre>
      {extension && worktree?.canEdit && worktree.snapshot && (
        <p>
          {/* A named extension is already explained by the server message. */}
          {!extension.name && <>{t("missingFunctionExtensionHint")} </>}
          <Link
            to={
              projectPageUrl(
                worktree.snapshot.worktree.project,
                "settings/extensions",
                worktree.id,
                environment,
              ) +
              (extension.name
                ? `&extension=${encodeURIComponent(extension.name)}`
                : "")
            }
          >
            {t("openExtensionSettings")}
          </Link>
        </p>
      )}
      {diagnostic && !current && (
        <p className="muted">{t("errorCodeChanged")}</p>
      )}
      <div className="row gap">
        <button
          className="button secondary small"
          onClick={() => onEditCode(current ? diagnostic?.line : undefined)}
        >
          <Code2 size={14} aria-hidden="true" />
          {current && diagnostic
            ? t("openErrorLine").replace("{line}", String(diagnostic.line))
            : t("editNodeCode")}
        </button>
        {onLog && (
          <button className="text-button" onClick={onLog}>
            {t("viewErrorLog")}
          </button>
        )}
        <AskAssistant
          node={node}
          run={failure.error_run}
          environment={environment}
        />
      </div>
      {diagnostic?.executed_sql && (
        <details>
          <summary>
            {t(
              diagnostic.phase === "compilation"
                ? "errorCompiledSql"
                : "executedSqlTitle",
            )}
          </summary>
          <pre>{diagnostic.executed_sql}</pre>
        </details>
      )}
    </section>
  );
}
