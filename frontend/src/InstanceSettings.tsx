import { NavLink } from "react-router";
import {
  Blocks,
  Database,
  GitBranch,
  KeyRound,
  Server,
  Users,
} from "lucide-react";
import { settingsSections } from "./navigation";
import UsersPage from "./UsersPage";
import ConnectionsPanel from "./ConnectionsPanel";
import EnvironmentsPanel from "./EnvironmentsPanel";
import ExtensionSettings from "./ExtensionSettings";
import GitHostsSettings from "./GitHostsSettings";
import { useT } from "./i18n";
import SSOSettings from "./SSOSettings";
import type { Workspace } from "./types";

const sectionIcons = {
  usersPermissions: Users,
  ssoSettings: KeyRound,
  gitHosts: GitBranch,
  environments: Server,
  connections: Database,
  extensions: Blocks,
};

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
      <div className="settings-container">
        <header className="settings-heading">
          <span className="eyebrow">{t("instance")}</span>
          <h1 id="instance-settings-heading">{t("instanceSettings")}</h1>
          <p className="muted">{t("instanceSettingsDescription")}</p>
        </header>
        <div className="settings-layout">
          <nav
            className="settings-navigation"
            aria-label={t("instanceSettings")}
          >
            {settingsSections.map(([slug, key]) => {
              const Icon = sectionIcons[key];
              return (
                <NavLink
                  to={`/instance-settings/${slug}`}
                  end
                  key={key}
                  className={section === key ? "active" : ""}
                  aria-current={section === key ? "page" : undefined}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span>{t(key)}</span>
                </NavLink>
              );
            })}
          </nav>
          <div className="settings-content" key={section}>
            {section === "usersPermissions" && <UsersPage refresh={refresh} />}
            {section === "extensions" && <ExtensionSettings />}
            {section === "ssoSettings" && <SSOSettings />}
            {section === "gitHosts" && <GitHostsSettings />}
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
          </div>
        </div>
      </div>
    </section>
  );
}
