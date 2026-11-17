import {
  KeyRound,
  LockKeyhole,
  SlidersHorizontal,
  Terminal,
} from "lucide-react";
import { NavLink } from "react-router";
import { useT } from "./i18n";
import { userSettingsSections, userSettingsUrl } from "./navigation";
import SettingsLayout from "./SettingsLayout";
import PasswordForm from "./PasswordForm";
import { usePreferenceChoices, type Preferences } from "./preferences";
import Select from "./Select";
import SSHKeySettings from "./SSHKeySettings";
import APITokenSettings from "./APITokenSettings";
import type { Workspace } from "./types";

const sectionIcons = {
  preferences: SlidersHorizontal,
  password: LockKeyhole,
  "ssh-key": Terminal,
  "api-tokens": KeyRound,
};

export default function UserSettings({
  workspace,
  preferences,
  onPasswordChanged,
  section = "preferences",
}: {
  workspace: Workspace;
  preferences: Preferences;
  onPasswordChanged: () => void;
  section?: string;
}) {
  const t = useT();
  const choices = usePreferenceChoices(preferences);
  return (
    <SettingsLayout
      className="settings-page user-settings"
      title={t("userSettings")}
      eyebrow={workspace.user.username}
      description={t("userSettingsDescription")}
      contentKey={section}
      navigation={userSettingsSections.map(([slug, label]) => {
        const Icon = sectionIcons[slug];
        return (
          <NavLink key={slug} to={userSettingsUrl(slug)} end>
            <Icon size={18} aria-hidden="true" />
            <span>{t(label)}</span>
          </NavLink>
        );
      })}
    >
      {section === "preferences" && (
        <div className="settings-card">
          <h2>{t("preferences")}</h2>
          <p className="muted">{t("localPreferences")}</p>
          <div className="settings-fields">
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
        </div>
      )}
      {section === "password" &&
        (workspace.user.auth_method === "oidc" ? (
          <div className="settings-card">
            <h2>{t("password")}</h2>
            <p>{t("ssoPasswordManaged")}</p>
          </div>
        ) : (
          <PasswordForm onChanged={onPasswordChanged} />
        ))}
      {section === "ssh-key" && <SSHKeySettings />}
      {section === "api-tokens" && <APITokenSettings />}
    </SettingsLayout>
  );
}
