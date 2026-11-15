import { useT } from "./i18n";
import type { Confirmation, Settings } from "./projectSettingsTypes";

export default function ProjectGeneralSettings({
  onGit,
  settings,
  admin,
  setConfirmation,
}: {
  onGit: (() => void) | undefined;
  settings: Settings | null;
  admin: boolean;
  setConfirmation: (confirmation: Confirmation) => void;
}) {
  const t = useT();
  return (
    <>
      {onGit && (
        <div className="settings-card">
          <h2>Git</h2>
          <button className="button secondary" onClick={onGit}>
            {t("connectGitRepository")}
          </button>
        </div>
      )}
      <div className="settings-card">
        <h2>{t("project")}</h2>
        <p>{settings?.project.name}</p>
      </div>
      {admin && (
        <div className="settings-card danger-zone">
          <h2>{t("deleteProject")}</h2>
          <p className="muted">{t("deleteProjectHint")}</p>
          <button
            className="button secondary danger"
            onClick={() => setConfirmation({ kind: "delete" })}
          >
            {t("deleteProject")}
          </button>
        </div>
      )}
    </>
  );
}
