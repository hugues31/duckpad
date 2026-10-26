import { useT } from "./i18n";
import { PreferenceButtons, type Preferences } from "./preferences";
import type { Workspace } from "./types";

export default function SettingsPage({
  workspace,
  preferences,
  onIdentity,
  onEnvironments,
}: {
  workspace: Workspace;
  preferences: Preferences;
  onIdentity: (identity: { name: string; email: string }) => void;
  onEnvironments: (names: string[]) => void;
}) {
  const t = useT();
  return (
    <section className="full-panel settings-page">
      <span className="eyebrow">{t("workspace")}</span>
      <h1>{t("settings")}</h1>
      <div className="settings-card">
        <h2>{t("identity")}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            onIdentity({
              name: String(data.get("name")),
              email: String(data.get("email")),
            });
          }}
        >
          <label className="field">
            <span>{t("authorName")}</span>
            <input
              name="name"
              defaultValue={workspace.identity.name}
              required
            />
          </label>
          <label className="field">
            <span>{t("authorEmail")}</span>
            <input
              name="email"
              type="email"
              defaultValue={workspace.identity.email}
              required
            />
          </label>
          <button className="button primary">{t("save")}</button>
        </form>
      </div>
      <div className="settings-card">
        <h2>{t("preferences")}</h2>
        <p className="muted">{t("localPreferences")}</p>
        <div className="row gap">
          <PreferenceButtons preferences={preferences} />
        </div>
      </div>
      <div className="settings-card">
        <h2>{t("environments")}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            onEnvironments(
              String(data.get("environments"))
                .split(",")
                .map((name) => name.trim())
                .filter(Boolean),
            );
          }}
        >
          <label className="field">
            <span>{t("environments")}</span>
            <input
              name="environments"
              defaultValue={workspace.catalog.environments.join(", ")}
            />
          </label>
          <button className="button secondary">{t("save")}</button>
        </form>
      </div>
    </section>
  );
}
