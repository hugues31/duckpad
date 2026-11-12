import { AlertCircle } from "lucide-react";
import { Link } from "react-router";
import { useT } from "./i18n";
import { projectPageUrl, worktreeUrl } from "./navigation";
import { partitionMessage } from "./partitions";
import { useLoadedWorktree } from "./worktree";

export default function RunFailureNotice() {
  const t = useT();
  const { runFailure: run, canEdit } = useLoadedWorktree();
  if (!run) return null;
  return (
    <section
      className="execution-error run-failure-notice"
      role="alert"
      aria-label={t("lastRunFailed")}
    >
      <div className="row gap">
        <AlertCircle size={18} aria-hidden="true" />
        <strong>{t("lastRunFailed")}</strong>
      </div>
      <pre className="execution-error-message">
        {partitionMessage(t, run.error!)}
      </pre>
      <div className="row gap">
        {canEdit && (
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
