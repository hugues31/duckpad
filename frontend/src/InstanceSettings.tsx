import { useState } from "react";
import { UsersPage } from "./Administration";
import ConnectionsPanel from "./ConnectionsPanel";
import { useT } from "./i18n";
import SSOSettings from "./SSOSettings";
import type { Workspace } from "./types";

const SECTIONS = [
  "instanceGeneral",
  "usersPermissions",
  "ssoSettings",
  "environments",
  "connections",
] as const;

export default function InstanceSettings({
  workspace,
  refresh,
  onIdentity,
  onEnvironments,
  onConnectorEditor,
}: {
  workspace: Workspace;
  refresh: () => Promise<void>;
  onIdentity: (identity: { name: string; email: string }) => void;
  onEnvironments: (names: string[]) => void;
  onConnectorEditor: (data: { title: string; value: string }) => void;
}) {
  const t = useT();
  const [section, setSection] =
    useState<(typeof SECTIONS)[number]>("instanceGeneral");
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
        {SECTIONS.map((key) => (
          <button
            key={key}
            className={section === key ? "active" : ""}
            aria-current={section === key ? "page" : undefined}
            onClick={() => setSection(key)}
          >
            {t(key)}
          </button>
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
      {section === "ssoSettings" && <SSOSettings />}
      {section === "environments" && (
        <div className="settings-card">
          <h2>{t("environments")}</h2>
          <p className="muted">{t("instanceEnvironmentsHint")}</p>
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
