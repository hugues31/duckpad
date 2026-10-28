import { PasswordForm } from "./Administration";
import { useT, type Language } from "./i18n";
import type { Preferences } from "./preferences";
import Select from "./Select";
import SSHKeySettings from "./SSHKeySettings";
import type { Theme, Workspace } from "./types";

export default function UserSettings({
  workspace,
  preferences,
  onPasswordChanged,
}: {
  workspace: Workspace;
  preferences: Preferences;
  onPasswordChanged: () => void;
}) {
  const t = useT();
  return (
    <section
      className="full-panel settings-page"
      aria-labelledby="user-settings-heading"
    >
      <span className="eyebrow">{workspace.user.username}</span>
      <h1 id="user-settings-heading">{t("userSettings")}</h1>
      <p className="muted">{t("userSettingsDescription")}</p>
      <div className="settings-card">
        <h2>{t("preferences")}</h2>
        <p className="muted">{t("localPreferences")}</p>
        <label className="field">
          <span>{t("language")}</span>
          <Select
            key={preferences.language}
            aria-label={t("language")}
            value={preferences.language}
            onChange={(e) =>
              preferences.setLanguage(e.target.value as Language)
            }
          >
            <option value="en">{t("english")}</option>
            <option value="fr">{t("french")}</option>
          </Select>
        </label>
        <label className="field">
          <span>{t("theme")}</span>
          <Select
            key={preferences.language}
            aria-label={t("theme")}
            value={preferences.theme}
            onChange={(e) => preferences.setTheme(e.target.value as Theme)}
          >
            <option value="light">{t("light")}</option>
            <option value="dark">{t("dark")}</option>
          </Select>
        </label>
      </div>
      {workspace.user.auth_method === "oidc" ? (
        <div className="settings-card">
          <h2>{t("password")}</h2>
          <p>{t("ssoPasswordManaged")}</p>
        </div>
      ) : (
        <PasswordForm onChanged={onPasswordChanged} />
      )}
      <SSHKeySettings />
    </section>
  );
}
