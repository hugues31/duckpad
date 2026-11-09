import { AlertCircle, Code2 } from "lucide-react";
import AskAssistant from "./AskAssistant";
import { executionErrorMessage } from "./executionErrors";
import { useT } from "./i18n";
import type { NodeResult } from "./types";
import { Link } from "react-router";
import { missingFunctionExtension } from "./extensions";
import { useOptionalWorktree } from "./worktree";
import { projectPageUrl } from "./navigation";

export default function ExecutionError({
  failure,
  node,
  environment,
  currentSource,
  onEditCode,
  onLog,
}: {
  failure: NodeResult;
  node: string;
  environment: string;
  currentSource: string;
  onEditCode: (line?: number) => void;
  onLog: () => void;
}) {
  const t = useT();
  const diagnostic = failure.diagnostic;
  const current = diagnostic?.source === currentSource;
  const worktree = useOptionalWorktree();
  const extension = missingFunctionExtension(
    diagnostic?.message || failure.error || "",
  );
  return (
    <section
      className="execution-error"
      role="alert"
      aria-label={t("lastRunFailed")}
    >
      <div className="row gap">
        <AlertCircle size={18} aria-hidden="true" />
        <strong>{t("lastRunFailed")}</strong>
        {diagnostic && (
          <span>
            {t("errorLine").replace("{line}", String(diagnostic.line))}
          </span>
        )}
      </div>
      <pre className="execution-error-message">
        {executionErrorMessage(diagnostic?.message || failure.error || "", t)}
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
        <button className="text-button" onClick={onLog}>
          {t("viewErrorLog")}
        </button>
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
