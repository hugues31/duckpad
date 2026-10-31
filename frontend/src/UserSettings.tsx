import { useT } from "./i18n";
import PasswordForm from "./PasswordForm";
import { usePreferenceChoices, type Preferences } from "./preferences";
import Select from "./Select";
import SSHKeySettings from "./SSHKeySettings";
import APITokenSettings from "./APITokenSettings";
import type { Workspace } from "./types";

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
  const choices = usePreferenceChoices(preferences);
  return (
    <section
      className="full-panel settings-page"
      aria-labelledby="user-settings-heading"
    >
      <div className="settings-container">
        <header className="settings-heading">
          <span className="eyebrow">{workspace.user.username}</span>
          <h1 id="user-settings-heading">{t("userSettings")}</h1>
          <p className="muted">{t("userSettingsDescription")}</p>
        </header>
        <div className="settings-grid">
          <div className="settings-card">
            <h2>{t("preferences")}</h2>
            <p className="muted">{t("localPreferences")}</p>
            {choices.map((choice) => (
              <label key={choice.name} className="field">
                <span>{choice.label}</span>
                <Select
                  key={preferences.language}
                  aria-label={choice.label}
                  value={choice.value}
                  onChange={(e) => choice.choose(e.target.value)}
                >
                  {choice.options.map(({ value, label }) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
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
          <APITokenSettings />
        </div>
      </div>
    </section>
  );
}
