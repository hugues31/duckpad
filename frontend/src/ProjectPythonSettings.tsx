import { useT } from "./i18n";
import { Settings } from "./projectSettingsTypes";
import PythonEnvironmentStatus from "./PythonEnvironmentStatus";
import { useSettingsForm } from "./useSettingsForm";
import { useOptionalWorktree } from "./worktree";

export default function ProjectPythonSettings({
  instanceAdmin,
  python,
  pending,
  onSave,
  project,
}: {
  instanceAdmin: boolean;
  python: ReturnType<typeof useSettingsForm<Settings["python"]>>;
  pending: boolean;
  onSave: () => void;
  project: string;
}) {
  const t = useT();
  const worktree = useOptionalWorktree();
  return (
    <>
      <div className="settings-card">
        <h2>{t("pythonExecution")}</h2>
        <p className="muted">{t("pythonTrustHint")}</p>
        {!instanceAdmin && (
          <p className="notice">{t("projectInstanceAdminHint")}</p>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            aria-label={t("pythonPolicy_enabled")}
            aria-description={t("pythonSecretsHint")}
            checked={python.config!.enabled}
            disabled={!instanceAdmin || pending}
            onChange={(event) => {
              const enabled = event.target.checked;
              // Source builds only apply to enabled Python.
              python.update((value) => ({
                ...value,
                enabled,
                allow_builds: enabled && value.allow_builds,
              }));
            }}
          />
          <span>
            <strong>{t("pythonPolicy_enabled")}</strong>
            <small>{t("pythonSecretsHint")}</small>
          </span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            aria-label={t("pythonPolicy_allow_builds")}
            aria-description={t("pythonBuildsHint")}
            checked={python.config!.allow_builds}
            disabled={!instanceAdmin || pending || !python.config!.enabled}
            onChange={(event) =>
              python.update((value) => ({
                ...value,
                allow_builds: event.target.checked,
              }))
            }
          />
          <span>
            <strong>{t("pythonPolicy_allow_builds")}</strong>
            <small>{t("pythonBuildsHint")}</small>
          </span>
        </label>
        {/* Others read the policy only: saving does not concern them. */}
        {instanceAdmin && (
          <>
            <p className="notice">{t("pythonResetHint")}</p>
            <div className="row gap">
              <button
                className="button primary"
                disabled={pending || !python.dirty}
                onClick={onSave}
              >
                {t("save")}
              </button>
              {python.dirty && (
                <span className="muted small">{t("unsavedChanges")}</span>
              )}
            </div>
          </>
        )}
      </div>
      <PythonEnvironmentStatus project={project} worktree={worktree?.id} />
    </>
  );
}
