import { NavLink } from "react-router";
import { settingsSections } from "./navigation";
import { UsersPage } from "./Administration";
import ConnectionsPanel from "./ConnectionsPanel";
import EnvironmentsPanel from "./EnvironmentsPanel";
import { useT } from "./i18n";
import SSOSettings from "./SSOSettings";
import type { Workspace } from "./types";

export default function InstanceSettings({
  section,
  workspace,
  refresh,
  onConnectorEditor,
}: {
  section: string;
  workspace: Workspace;
  refresh: () => Promise<void>;
  onConnectorEditor: (data: { title: string; value: string }) => void;
}) {
  const t = useT();
  return (
    <section
      className="full-panel instance-settings"
      aria-labelledby="instance-settings-heading"
    >
      <span className="eyebrow">{t("instance")}</span>
      <h1 id="instance-settings-heading">{t("instanceSettings")}</h1>
      <p className="muted">{t("instanceSettingsDescription")}</p>
      <nav
        className="tabs settings-navigation"
        aria-label={t("instanceSettings")}
      >
        {settingsSections.map(([slug, key]) => (
          <NavLink
            to={`/instance-settings${slug ? `/${slug}` : ""}`}
            end
            key={key}
            className={section === key ? "active" : ""}
            aria-current={section === key ? "page" : undefined}
          >
            {t(key)}
          </NavLink>
        ))}
      </nav>
      {section === "instanceGeneral" && (
        <div className="settings-card">
          <h2>{t("identity")}</h2>
          <p className="muted">{t("accountIdentityHint")}</p>
        </div>
      )}
      {section === "usersPermissions" && <UsersPage refresh={refresh} />}
      {section === "ssoSettings" && <SSOSettings />}
      {section === "environments" && (
        <EnvironmentsPanel
          environments={workspace.catalog.environment_details}
          refresh={refresh}
        />
      )}
      {section === "connections" && (
        <ConnectionsPanel
          workspace={workspace}
          refresh={refresh}
          onEditor={onConnectorEditor}
        />
      )}
    </section>
  );
}
