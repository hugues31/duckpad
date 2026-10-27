import { NavLink } from "react-router";
import { settingsSections } from "./navigation";
import { UsersPage } from "./Administration";
import ConnectionsPanel from "./ConnectionsPanel";
import EnvironmentsPanel from "./EnvironmentsPanel";
import ExtensionSettings from "./ExtensionSettings";
import { useT } from "./i18n";
import SSOSettings from "./SSOSettings";
import type { Workspace } from "./types";

export default function InstanceSettings({
  section,
  workspace,
  refresh,
  onIdentity,
  onConnectorEditor,
}: {
  section: string;
  workspace: Workspace;
  refresh: () => Promise<void>;
  onIdentity: (identity: { name: string; email: string }) => void;
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
          <p className="muted">{t("instanceIdentityHint")}</p>
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
      )}
      {section === "usersPermissions" && <UsersPage refresh={refresh} />}
      {section === "instanceGeneral" && <ExtensionSettings />}
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
