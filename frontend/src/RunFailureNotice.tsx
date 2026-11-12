import { AlertCircle, X } from "lucide-react";
import { Link } from "react-router";
import { projectExtensionsFailed } from "./extensions";
import { useT } from "./i18n";
import { projectPageUrl, worktreeUrl } from "./navigation";
import { partitionMessage } from "./partitions";
import { useLoadedWorktree } from "./worktree";

/** The error of a run that failed as a whole, which no node result shows. */
export default function RunFailureNotice() {
  const t = useT();
  const { runFailure: run, dismissRunFailure, canEdit } = useLoadedWorktree();
  if (!run) return null;
  const error = run.error || "";
  return (
    <section
      className="execution-error run-failure-notice"
      role="alert"
      aria-label={t("lastRunFailed")}
    >
      <div className="row gap">
        <AlertCircle size={18} aria-hidden="true" />
        <strong>{t("lastRunFailed")}</strong>
        <button
          className="icon"
          title={t("close")}
          aria-label={t("close")}
          onClick={dismissRunFailure}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <pre className="execution-error-message">
        {partitionMessage(t, error)}
      </pre>
      <div className="row gap">
        {canEdit && projectExtensionsFailed(error) && (
          <Link
            to={projectPageUrl(
              run.project,
              "settings/extensions",
              run.worktree,
              run.environment,
            )}
          >
            {t("openExtensionSettings")}
          </Link>
        )}
        <Link
          to={worktreeUrl(run.worktree, "history", run.environment, {
            run: run.id,
          })}
        >
          {t("runHistory")}
        </Link>
      </div>
    </section>
  );
}
